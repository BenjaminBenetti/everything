import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod } from "node:fs/promises";
import path from "node:path";
import pRetry from "p-retry";
import type { SshAgent } from "../interface/ssh-agent.js";
import {
  agentMessage,
  agentRequest,
  frame,
  messageType,
  parseIdentities,
  sshString,
} from "./agent-protocol.js";
import { preparePrivateSocket, removeSocket } from "./private-socket.js";
import { sshPublicKey } from "./ssh-public-key.js";

/** Longest an agent request or `ssh-add` may take before the agent counts as unavailable. */
const commandTimeoutMs = 5000;

/** Run a foreground OpenSSH agent and feed keys through stdin, never arguments, files, or logs. */
export class OpenSshAgent implements SshAgent {
  // ===========================================
  // State and construction
  // ===========================================

  private child: ChildProcess | undefined;
  private exited: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;

  /** Use an application-owned directory that no socket consumer can reach or write. */
  constructor(readonly socketPath: string) {
    if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100)
      throw new Error("SSH agent requires a bounded absolute socket path");
  }

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Coalesce startup and recreate an exited agent at the same path for existing consumers. */
  async start(): Promise<void> {
    if (this.closed) throw new Error("SSH agent is closed");
    if (this.starting) return this.starting;
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
      return;
    this.starting = this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Stop a locked or unresponsive agent, discarding every identity, and start a fresh one. */
  async restart(): Promise<void> {
    if (this.closed) throw new Error("SSH agent is closed");
    await this.starting?.catch(() => undefined);
    await this.stopChild();
    await this.start();
  }

  /** Stop the child before removing its socket; shutdown never leaves a detached key holder. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.starting?.catch(() => undefined);
    await this.stopChild();
    await removeSocket(this.socketPath);
  }

  // ===========================================
  // Identities
  // ===========================================

  /** List public keys over the agent protocol; a locked agent answers with none. */
  async identities(): Promise<ReadonlySet<string>> {
    const reply = await agentRequest(
      this.socketPath,
      frame(agentMessage.requestIdentities),
      commandTimeoutMs,
    );
    return new Set(
      parseIdentities(reply).map(({ blob }) => blob.toString("base64")),
    );
  }

  /**
   * Load one key through `ssh-add`'s stdin and confirm the agent now offers its public key. A
   * refusal counts against the material only if the agent still accepts a throwaway key; an agent
   * that refuses every key, such as a locked one, throws so it can be replaced.
   */
  async add(material: string): Promise<string | undefined> {
    // OpenSSH's private-key reader requires a terminating newline, including pasted keys.
    const normalized = `${material.trim().replace(/\r\n/g, "\n")}\n`;
    const publicKey = sshPublicKey(normalized);
    if (!publicKey) return undefined;
    const result = await this.command(["-q", "-"], normalized);
    if (result === 2) throw new Error("SSH agent is unavailable");
    if (result === 0 && (await this.identities()).has(publicKey))
      return publicKey;
    if (!(await this.acceptsIdentities()))
      throw new Error("SSH agent refuses new identities");
    return undefined;
  }

  /** Remove one identity over the agent protocol; a refusal means the agent cannot be trusted to revoke. */
  async remove(publicKey: string): Promise<void> {
    const reply = await agentRequest(
      this.socketPath,
      frame(
        agentMessage.removeIdentity,
        sshString(Buffer.from(publicKey, "base64")),
      ),
      commandTimeoutMs,
    );
    if (messageType(reply) !== agentMessage.success)
      throw new Error("SSH agent refused to remove an identity");
  }

  /** Add and remove a throwaway Ed25519 key generated in memory, which only a refusing agent rejects. */
  private async acceptsIdentities(): Promise<boolean> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const point = Buffer.from(
      publicKey.export({ format: "jwk" }).x!,
      "base64url",
    );
    const seed = Buffer.from(
      privateKey.export({ format: "jwk" }).d!,
      "base64url",
    );
    const reply = await agentRequest(
      this.socketPath,
      frame(
        agentMessage.addIdentity,
        sshString("ssh-ed25519"),
        sshString(point),
        sshString(Buffer.concat([seed, point])),
        sshString("everything-probe"),
      ),
      commandTimeoutMs,
    );
    if (messageType(reply) !== agentMessage.success) return false;
    await this.remove(
      Buffer.concat([sshString("ssh-ed25519"), sshString(point)]).toString(
        "base64",
      ),
    );
    return true;
  }

  // ===========================================
  // Process boundary
  // ===========================================

  /** Bind a private stable socket, suppress child diagnostics, and wait until OpenSSH answers. */
  private async launch(): Promise<void> {
    await preparePrivateSocket(this.socketPath);
    if (this.closed) return;
    const child = spawn("/usr/bin/ssh-agent", ["-D", "-a", this.socketPath], {
      env: this.environment(),
      stdio: "ignore",
    });
    this.child = child;
    this.exited = new Promise<void>((resolve) => {
      child.once("error", () => resolve());
      child.once("close", () => resolve());
    });
    try {
      await pRetry(
        async () => {
          if (
            this.closed ||
            child.exitCode !== null ||
            child.signalCode !== null
          )
            throw new Error("SSH agent could not start");
          await this.identities();
        },
        { retries: 20, minTimeout: 25, maxTimeout: 100 },
      );
      await chmod(this.socketPath, 0o600);
    } catch {
      await this.stopChild();
      throw new Error("SSH agent could not start");
    }
  }

  /** Bound `ssh-add`, disable prompts, and discard output because it may contain key comments. */
  private command(
    args: readonly string[],
    input: string,
  ): Promise<number | null> {
    if (this.closed) return Promise.reject(new Error("SSH agent is closed"));
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/ssh-add", [...args], {
        env: this.environment(),
        stdio: ["pipe", "ignore", "ignore"],
      });
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, commandTimeoutMs);
      // Public keys and locked private keys may make ssh-add exit before consuming all stdin.
      child.stdin.on("error", () => undefined);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("SSH agent command could not start"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failed) reject(new Error("SSH agent command did not complete"));
        else resolve(code);
      });
      child.stdin.end(input);
    });
  }

  /** Pass only the socket and basic executable settings, excluding application credentials. */
  private environment(): NodeJS.ProcessEnv {
    return {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      SSH_AUTH_SOCK: this.socketPath,
      SSH_ASKPASS: "/bin/false",
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: ":0",
    };
  }

  /** Reap the foreground child, escalating termination only if its grace period expires. */
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.kill("SIGTERM");
      await this.exited;
      clearTimeout(timer);
    }
    this.child = undefined;
  }
}
