/** Runs programs without a shell, so arguments are never interpreted. */
export interface CommandRunner {
  /** Run a program to completion, rejecting with a CommandFailure when it fails. */
  run(program: string, args: readonly string[]): Promise<void>;
}

/** A program exited unsuccessfully; `output` is the end of its error output. */
export class CommandFailure extends Error {
  /** Keep the output that explains the failure. */
  constructor(
    readonly program: string,
    readonly output: string,
  ) {
    super(`${program} failed`);
    this.name = "CommandFailure";
  }
}
