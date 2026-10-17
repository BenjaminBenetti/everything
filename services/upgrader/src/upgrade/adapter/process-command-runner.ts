import { spawn } from "node:child_process";
import {
  CommandFailure,
  type CommandRunner,
} from "../interface/command-runner.js";

/** The end of a program's error output kept to explain a failure. */
const keptOutputBytes = 8 * 1024;

/** Runs programs as child processes, passing their output through to this process's. */
export class ProcessCommandRunner implements CommandRunner {
  /** Run the program, keeping the end of its error output for a failure. */
  run(program: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
      let errors = "";
      child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        errors = (errors + chunk.toString("utf8")).slice(-keptOutputBytes);
      });
      child.once("error", (error) =>
        reject(new CommandFailure(program, error.message)),
      );
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new CommandFailure(program, errors));
      });
    });
  }
}
