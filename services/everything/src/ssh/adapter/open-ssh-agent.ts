import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import pRetry from "p-retry";
import type {
  SshAgent,
  SshIdentity,
  SshIdentityResult,
} from "../interface/ssh-agent.js";

/** Run a foreground OpenSSH agent and feed keys through stdin, never arguments, files, or logs. */
export class OpenSshAgent implements SshAgent {
  // ===========================================
  // State and construction
  // ===========================================

  private child: ChildProcess | undefined;
  private exited: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;

  /** Use an application-owned directory whose parent is not writable by socket consumers. */
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

  /** Stop the child before removing its socket; shutdown never leaves a detached key holder. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.starting?.catch(() => undefined);
    await this.stopChild();
    await this.removeSocket();
  }

  // ===========================================
  // Identities
  // ===========================================

  /** Hash only public identities; an empty agent is healthy and has an empty inventory. */
  async inventory(): Promise<string> {
    const result = await this.command(["-L"]);
    if (result.code !== 0 && result.code !== 1)
      throw new Error("SSH agent is unavailable");
    return createHash("sha256")
      .update(result.code === 1 ? "" : result.output)
      .digest("hex");
  }

  /** Remove deleted identities first, then independently load every usable private key. */
  async replace(
    identities: readonly SshIdentity[],
  ): Promise<readonly SshIdentityResult[]> {
    if ((await this.command(["-D"])).code !== 0)
      throw new Error("SSH agent could not clear identities");
    const results: SshIdentityResult[] = [];
    for (const identity of identities) {
      // OpenSSH's private-key reader requires a terminating newline, including pasted keys.
      const material = `${identity.material.trim().replace(/\r\n/g, "\n")}\n`;
      const result = await this.command(["-q", "-"], material);
      if (result.code === 2) throw new Error("SSH agent is unavailable");
      results.push({ id: identity.id, loaded: result.code === 0 });
    }
    return results;
  }

  // ===========================================
  // Process boundary
  // ===========================================

  /** Bind a private stable socket, suppress child diagnostics, and wait until OpenSSH answers. */
  private async launch(): Promise<void> {
    const directory = path.dirname(this.socketPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory())
      throw new Error("SSH agent directory must not be a symlink");
    await chmod(directory, 0o700);
    await this.removeSocket();
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
          await this.inventory();
        },
        { retries: 20, minTimeout: 25, maxTimeout: 100 },
      );
      await chmod(this.socketPath, 0o600);
    } catch {
      await this.stopChild();
      throw new Error("SSH agent could not start");
    }
  }

  /** Bound each operation, disable prompts, and discard stderr because it may contain key comments. */
  private command(
    args: readonly string[],
    input?: string,
  ): Promise<{ code: number | null; output: string }> {
    if (this.closed) return Promise.reject(new Error("SSH agent is closed"));
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/ssh-add", [...args], {
        env: this.environment(),
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, 5000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          failed = true;
          child.kill("SIGKILL");
        } else chunks.push(chunk);
      });
      // Public keys and locked private keys may make ssh-add exit before consuming all stdin.
      child.stdin.on("error", () => undefined);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("SSH agent command could not start"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failed) reject(new Error("SSH agent command did not complete"));
        else resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
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

  /** Remove only the managed socket, refusing ordinary files and symlinks at that path. */
  private async removeSocket(): Promise<void> {
    const entry = await lstat(this.socketPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!entry) return;
    if (!entry.isSocket()) throw new Error("SSH agent path is not a socket");
    await unlink(this.socketPath);
  }
}
