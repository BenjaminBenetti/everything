import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** A command whose supervisor accepts SIGTERM to stop and reap only its own descendants. */
export type CommandProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Launch isolated command lifecycles without owning workspace policy or output limits. */
export interface CommandProcessFactory {
  /** Start Bash with the supplied working directory and environment. */
  spawn(
    command: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ): CommandProcess;
}
