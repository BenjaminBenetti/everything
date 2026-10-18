import {
  workspaceLimits,
  type BashInput,
  type BashResult,
} from "@everything/workspace-contracts";
import type { WorkspaceDirectories } from "../../workspace/interface/workspace-files.js";
import type { CommandRunner } from "../interface/command-runner.js";
import type { CommandProcessFactory } from "../interface/command-process-factory.js";
import { commandEnvironment } from "../model/command-environment.js";
import { SecretRedactor } from "../model/secret-redactor.js";

/** Run concurrent commands with independently bounded output, cancellation, and cleanup. */
export class BashRunner implements CommandRunner {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly active = new Set<AbortController>();
  private closed = false;

  /**
   * Receive workspace path policy, isolated command creation, the variables commands inherit, which
   * default to the allowlisted part of this process's environment with the workspace as home, and
   * secrets that are redacted from output, such as the Fleet client token commands can read.
   */
  constructor(
    private readonly files: WorkspaceDirectories,
    private readonly processes: CommandProcessFactory,
    private readonly environment = commandEnvironment(process.env, files.home),
    private readonly secrets: readonly string[] = [],
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
    if (this.closed) throw new Error("Command interrupted.");
    const cancellation = new AbortController();
    this.active.add(cancellation);
    try {
      const home = await this.files.directory();
      const cwd = await this.files.directory(input.cwd);
      signal?.throwIfAborted();
      if (cancellation.signal.aborted) throw new Error("Command interrupted.");
      return await new Promise<BashResult>((resolve, reject) => {
        const child = this.processes.spawn(input.command, cwd, {
          ...this.environment,
          HOME: home,
        });
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
        /** Ask this command's supervisor to kill and reap only its descendants. */
        const kill = (): void => {
          child.kill("SIGTERM");
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
        const stdout = new SecretRedactor(this.secrets);
        const stderr = new SecretRedactor(this.secrets);
        child.stdout.on("data", (chunk: Buffer) => collect(stdout.push(chunk)));
        child.stderr.on("data", (chunk: Buffer) => collect(stderr.push(chunk)));
        signal?.addEventListener("abort", kill, { once: true });
        cancellation.signal.addEventListener("abort", kill, { once: true });
        // The supervisor exits only after descendants have released their inherited pipes.
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) => {
          clearTimeout(timer);
          collect(stdout.end());
          collect(stderr.end());
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
      this.active.delete(cancellation);
    }
  }

  /** Stop every active command and reject new work while the API drains for pod termination. */
  close(): void {
    this.closed = true;
    for (const cancellation of this.active) cancellation.abort();
  }
}
