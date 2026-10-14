import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  CommandProcess,
  CommandProcessFactory,
} from "../interface/command-process-factory.js";

/** Give each command a Linux subreaper that contains cleanup to that command's descendants. */
export class LinuxCommandProcessFactory implements CommandProcessFactory {
  // ===========================================
  // Process creation
  // ===========================================

  /** Launch the packaged supervisor, keeping output pipes and exit status owned by this command. */
  spawn(
    command: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ): CommandProcess {
    return spawn(
      fileURLToPath(import.meta.resolve("#command-supervisor")),
      [command],
      {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      },
    );
  }
}
