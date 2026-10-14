import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FleetCommands } from "../interface/fleet-commands.js";

const execFileAsync = promisify(execFile);

/** Longest a command may take; a connection check waits on the cluster's API server. */
const commandTimeoutMs = 120_000;

/** Run Fleet's executable as its command-line client, in Fleet's environment. */
export class FleetCli implements FleetCommands {
  /** Use the installed executable and the environment fleetd runs with. */
  constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  /** Run one command; a failure carries Fleet's own explanation. */
  async run(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.executable, [...args], {
        env: this.environment,
        timeout: commandTimeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(
        `fleet ${args.slice(0, 2).join(" ")} failed${stderr ? `: ${stderr}` : "."}`,
        { cause: error },
      );
    }
  }
}
