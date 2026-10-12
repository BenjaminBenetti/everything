import { spawn } from "node:child_process";
import {
  workspaceLimits,
  type BashInput,
  type BashResult,
} from "@everything/workspace-contracts";
import type { WorkspaceDirectories } from "../../workspace/interface/workspace-files.js";
import type { CommandRunner } from "../interface/command-runner.js";
import { commandEnvironment } from "../model/command-environment.js";
import { WorkspaceBusyError } from "../../workspace/error/workspace-errors.js";

/** Execute commands in the teammate container, with bounded output and process-group cancellation. */
export class BashRunner implements CommandRunner {
  // ===========================================
  // Construction and state
  // ===========================================

  private active: AbortController | undefined;

  /**
   * Receive workspace path policy, a container-wide descendant cleanup operation, and the variables
   * commands inherit, which default to the allowlisted part of this process's environment.
   */
  constructor(
    private readonly files: WorkspaceDirectories,
    private readonly reap: () => void = () => {},
    private readonly environment = commandEnvironment(process.env),
  ) {}

  // ===========================================
  // Execution
  // ===========================================

  /**
   * Run Bash with only the allowlisted environment and the workspace as HOME, so user-level installs
   * and settings land in one place whatever the working directory. Kill descendants on timeout,
   * interruption, or completion.
   */
  async run(input: BashInput, signal?: AbortSignal): Promise<BashResult> {
    signal?.throwIfAborted();
    if (this.active) throw new WorkspaceBusyError();
    const cancellation = new AbortController();
    this.active = cancellation;
    try {
      const home = await this.files.directory();
      const cwd = await this.files.directory(input.cwd);
      signal?.throwIfAborted();
      return await new Promise<BashResult>((resolve, reject) => {
        const child = spawn(
          "/bin/bash",
          ["--noprofile", "--norc", "-c", input.command],
          {
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...this.environment, HOME: home },
          },
        );
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let timedOut = false;
        /** Retain only the bounded prefix while continuing to drain both pipes. */
        const collect = (chunk: Buffer): void => {
          const remaining = workspaceLimits.outputBytes - size;
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          size += Math.min(chunk.length, Math.max(remaining, 0));
          if (chunk.length > remaining) truncated = true;
        };
        /** Stop the process group immediately so interruptions do not leave writers behind. */
        const kill = (): void => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                throw error;
            }
          }
          this.reap();
        };
        const timer = setTimeout(
          () => {
            timedOut = true;
            kill();
          },
          Math.min(
            input.timeoutSeconds ?? workspaceLimits.defaultTimeoutSeconds,
            workspaceLimits.timeoutSeconds,
          ) * 1000,
        );
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        signal?.addEventListener("abort", kill, { once: true });
        cancellation.signal.addEventListener("abort", kill, { once: true });
        // `exit` precedes `close`: descendants may still have inherited the output pipes.
        child.once("exit", kill);
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", kill);
          cancellation.signal.removeEventListener("abort", kill);
          if (signal?.aborted || cancellation.signal.aborted)
            reject(new Error("Command interrupted."));
          else
            resolve({
              output: Buffer.concat(chunks).toString("utf8"),
              exitCode,
              signal: exitSignal,
              truncated,
              timedOut,
            });
        });
        if (signal?.aborted || cancellation.signal.aborted) kill();
      });
    } finally {
      this.active = undefined;
    }
  }

  /** Stop the active command while the API drains for pod termination. */
  close(): void {
    this.active?.abort();
  }
}
