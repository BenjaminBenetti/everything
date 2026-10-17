import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { agentRequest, frame, sshString } from "../adapter/agent-protocol.js";

export const execute = promisify(execFile);

/** A disposable key pair generated for one test and never used against an external service. */
export interface KeyFixture {
  readonly file: string;
  readonly material: string;
  readonly publicKey: string;
  /** The base64 wire-format public key, as agents list it. */
  readonly blob: string;
}

/** Generate a synthetic key pair in `directory` with `ssh-keygen`. */
export async function createKey(
  directory: string,
  name: string,
  options: {
    readonly type?: "ed25519" | "rsa" | "ecdsa";
    readonly format?: "PEM" | "PKCS8";
    readonly passphrase?: string;
  } = {},
): Promise<KeyFixture> {
  const file = path.join(directory, name);
  const generation = execute("ssh-keygen", [
    "-q",
    "-t",
    options.type ?? "ed25519",
    ...(options.type === "rsa" ? ["-b", "2048"] : []),
    ...(options.format ? ["-m", options.format] : []),
    "-N",
    options.passphrase ?? "",
    "-C",
    name,
    "-f",
    file,
  ]);
  // An existing file makes ssh-keygen ask before overwriting it; end stdin so that fails at once.
  generation.child.stdin?.end();
  await generation;
  const publicKey = await readFile(`${file}.pub`, "utf8");
  return {
    file,
    material: await readFile(file, "utf8"),
    publicKey,
    blob: publicKey.split(" ")[1]!,
  };
}

/** The variables an `ssh-add` run needs to reach `socket`, and nothing of this process's own. */
export function agentEnvironment(socket: string): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: socket };
}

/** Run `ssh-add` against `socket` and return its exit status; output is discarded. */
export async function sshAdd(
  socket: string,
  args: readonly string[],
): Promise<number> {
  try {
    await execute("ssh-add", [...args], { env: agentEnvironment(socket) });
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
}

/** Lock the agent at `socket` with a password, as `ssh-add -x` would, and return the reply type. */
export async function lockAgent(socket: string): Promise<number> {
  const reply = await agentRequest(
    socket,
    frame(22, sshString("disposable-lock-password")),
    5000,
  );
  return reply[4]!;
}

/** Kill the OpenSSH agent serving `socket`, as if it had crashed. */
export async function killAgent(socket: string): Promise<void> {
  await execute("pkill", ["-KILL", "-f", `ssh-agent -D -a ${socket}`]);
}
