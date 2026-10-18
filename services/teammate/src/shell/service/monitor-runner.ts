import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  monitorLimits,
  monitorLogDirectory,
  type MonitorInput,
  type MonitorResult,
  type MonitorStatus,
} from "@everything/workspace-contracts/monitor";
import type { WorkspaceDirectories } from "../../workspace/interface/workspace-files.js";
import type { CommandMonitors } from "../interface/command-monitors.js";
import type {
  CommandProcess,
  CommandProcessFactory,
} from "../interface/command-process-factory.js";
import { commandEnvironment } from "../model/command-environment.js";
import { BoundedOutput } from "../model/bounded-output.js";
import { SecretRedactor } from "../model/secret-redactor.js";
import {
  defaultMonitorPolicy,
  type MonitorPolicy,
} from "../model/monitor-policy.js";
import {
  MonitorLimitError,
  MonitorNotFoundError,
  MonitorsClosedError,
} from "../error/monitor-errors.js";

/** One background command and the state reported for it. */
interface MonitorRecord {
  readonly id: string;
  readonly log: string;
  readonly startedAt: string;
  readonly output: BoundedOutput;
  readonly done: Promise<void>;
  status: MonitorStatus;
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  finishedAt: string | null;
  logTruncated: boolean;
  timedOut: boolean;
  stopReason: string | null;
  waiters: number;
  seenAt: number;
  endedAt: number;
  kill(): void;
}

const logName = /^[0-9a-f-]{36}\.log$/;

/**
 * Run commands that continue after the request that started them, in the same supervisor, environment,
 * and working-directory policy as the Bash tool. Output is bounded in memory and logged to the
 * workspace up to a fixed size. A command stops at its timeout, on request, at shutdown, or when no
 * caller has waited for it within the lease, so a lost caller never leaves it running indefinitely.
 */
export class MonitorRunner implements CommandMonitors {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly records = new Map<string, MonitorRecord>();
  private readonly sweeper: NodeJS.Timeout;
  private starting = 0;
  private closed = false;

  /**
   * Receive the Bash tool's path policy, supervisor, environment, and redacted secrets, plus lifetime
   * policy and a clock.
   */
  constructor(
    private readonly files: WorkspaceDirectories,
    private readonly processes: CommandProcessFactory,
    private readonly policy: MonitorPolicy = defaultMonitorPolicy,
    private readonly environment = commandEnvironment(process.env, files.home),
    private readonly now: () => number = Date.now,
    private readonly secrets: readonly string[] = [],
  ) {
    this.sweeper = setInterval(() => this.sweep(), policy.sweepMs);
    this.sweeper.unref();
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Resolve the directories and log, then start the command without waiting for it to finish. */
  async start(input: MonitorInput): Promise<MonitorResult> {
    if (this.closed) throw new MonitorsClosedError();
    if (this.running + this.starting >= monitorLimits.concurrent)
      throw new MonitorLimitError(monitorLimits.concurrent);
    this.starting++;
    try {
      const home = await this.files.directory();
      const cwd = await this.files.directory(input.cwd);
      const directory = path.join(home, monitorLogDirectory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await this.prune(directory);
      if (this.closed) throw new MonitorsClosedError();
      const id = randomUUID();
      const log = createWriteStream(path.join(directory, `${id}.log`), {
        flags: "wx",
        mode: 0o600,
      });
      const record = this.launch(id, input, cwd, home, log);
      this.records.set(id, record);
      return this.snapshot(record);
    } finally {
      this.starting--;
    }
  }

  /** Hold the request until the command finishes or the wait elapses, renewing its lease. */
  async wait(id: string, waitMs: number): Promise<MonitorResult> {
    const record = this.require(id);
    record.waiters++;
    record.seenAt = this.now();
    const elapsed = new AbortController();
    try {
      if (record.status === "running")
        await Promise.race([
          record.done,
          delay(waitMs, undefined, { signal: elapsed.signal }).catch(() => {}),
        ]);
    } finally {
      elapsed.abort();
      record.waiters--;
      record.seenAt = this.now();
    }
    return this.snapshot(record);
  }

  /** Stop the command and its descendants, then report how it ended. */
  async cancel(id: string): Promise<MonitorResult> {
    const record = this.require(id);
    record.seenAt = this.now();
    this.stop(record, "The monitor was stopped on request.");
    await record.done;
    return this.snapshot(record);
  }

  /** Refuse new commands and stop every running one before the pod is replaced. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const record of this.records.values())
      this.stop(record, "The teammate's workspace stopped.");
    await Promise.all([...this.records.values()].map(({ done }) => done));
  }

  // ===========================================
  // Process lifecycle
  // ===========================================

  /**
   * Spawn the supervised command, collecting bounded output and logging it until the size limit, with
   * secrets redacted from both.
   */
  private launch(
    id: string,
    input: MonitorInput,
    cwd: string,
    home: string,
    log: WriteStream,
  ): MonitorRecord {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let child: CommandProcess | undefined;
    let spawned = false;
    let settled = false;
    let logged = 0;
    const record: MonitorRecord = {
      id,
      log: `${monitorLogDirectory}/${id}.log`,
      startedAt: new Date(this.now()).toISOString(),
      output: new BoundedOutput(
        monitorLimits.headBytes,
        monitorLimits.tailBytes,
      ),
      done,
      status: "running",
      exitCode: null,
      signal: null,
      reason: null,
      finishedAt: null,
      logTruncated: false,
      timedOut: false,
      stopReason: null,
      waiters: 0,
      seenAt: this.now(),
      endedAt: 0,
      /** Ask this command's supervisor to kill and reap only its descendants. */
      kill: () => {
        child?.kill("SIGTERM");
      },
    };
    log.on("error", () => {
      record.logTruncated = true;
    });
    /** Retain bounded output and append to the log until it reaches its size limit. */
    const collect = (chunk: Buffer): void => {
      record.output.append(chunk);
      const remaining = monitorLimits.logBytes - logged;
      if (remaining > 0 && !log.destroyed)
        log.write(chunk.subarray(0, remaining));
      logged += Math.min(chunk.length, Math.max(remaining, 0));
      if (chunk.length > remaining) record.logTruncated = true;
    };
    /** Record the outcome once, after the log has been flushed. */
    const settle = (
      status: MonitorStatus,
      exitCode: number | null,
      signal: string | null,
      reason: string | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.end();
      void finished(log)
        .catch(() => {
          record.logTruncated = true;
        })
        .then(() => {
          Object.assign(record, {
            status,
            exitCode,
            signal,
            reason,
            finishedAt: new Date(this.now()).toISOString(),
            endedAt: this.now(),
          });
          finish();
        });
    };
    const timer = setTimeout(
      () => {
        record.timedOut = true;
        record.kill();
      },
      (input.timeoutSeconds ?? monitorLimits.defaultTimeoutSeconds) * 1000,
    );
    try {
      child = this.processes.spawn(input.command, cwd, {
        ...this.environment,
        HOME: home,
      });
    } catch {
      settle("failed", null, null, "The command could not start.");
      return record;
    }
    child.once("spawn", () => {
      spawned = true;
    });
    const stdout = new SecretRedactor(this.secrets);
    const stderr = new SecretRedactor(this.secrets);
    child.stdout.on("data", (chunk: Buffer) => collect(stdout.push(chunk)));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr.push(chunk)));
    // A failed spawn reports only an error; a running command's errors precede its close event.
    child.once("error", () => {
      if (!spawned)
        settle("failed", null, null, "The command could not start.");
    });
    // The supervisor exits only after descendants have released their inherited pipes.
    child.once("close", (exitCode, signal) => {
      collect(stdout.end());
      collect(stderr.end());
      if (record.stopReason !== null)
        settle("cancelled", exitCode, signal, record.stopReason);
      else if (record.timedOut)
        settle(
          "timed-out",
          exitCode,
          signal,
          `The command reached its ${input.timeoutSeconds ?? monitorLimits.defaultTimeoutSeconds}-second timeout.`,
        );
      else settle("exited", exitCode, signal, null);
    });
    return record;
  }

  /** Kill a running command, keeping the first reason given. */
  private stop(record: MonitorRecord, reason: string): void {
    if (record.status !== "running") return;
    record.stopReason ??= reason;
    record.kill();
  }

  /** Stop commands nobody is waiting for and forget results kept past their retention. */
  private sweep(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      if (
        record.status === "running" &&
        record.waiters === 0 &&
        now - record.seenAt > this.policy.leaseMs
      )
        this.stop(
          record,
          "No one was waiting for the result, so the command was stopped.",
        );
      else if (
        record.status !== "running" &&
        now - record.endedAt > this.policy.retentionMs
      )
        this.records.delete(record.id);
    }
  }

  /** Keep the newest finished logs, making room for one more, without touching running commands' logs. */
  private async prune(directory: string): Promise<void> {
    const active = new Set(
      [...this.records.values()]
        .filter(({ status }) => status === "running")
        .map(({ id }) => `${id}.log`),
    );
    const logs = await Promise.all(
      (await readdir(directory))
        .filter((name) => logName.test(name) && !active.has(name))
        .map(async (name) => ({
          name,
          modified: (
            await stat(path.join(directory, name)).catch(() => ({ mtimeMs: 0 }))
          ).mtimeMs,
        })),
    );
    logs.sort((left, right) => right.modified - left.modified);
    await Promise.all(
      logs
        .slice(Math.max(monitorLimits.retainedLogs - 1, 0))
        .map(({ name }) => rm(path.join(directory, name), { force: true })),
    );
  }

  // ===========================================
  // Reporting
  // ===========================================

  /** Running commands, excluding any still being started. */
  private get running(): number {
    return [...this.records.values()].filter(
      ({ status }) => status === "running",
    ).length;
  }

  /** Find a tracked command; unknown and forgotten IDs look the same. */
  private require(id: string): MonitorRecord {
    const record = this.records.get(id);
    if (!record) throw new MonitorNotFoundError();
    return record;
  }

  /** Copy the public state, decoding output without splitting characters. */
  private snapshot(record: MonitorRecord): MonitorResult {
    return {
      id: record.id,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      output: record.output.text(),
      outputBytes: record.output.bytes,
      truncated: record.output.truncated,
      log: record.log,
      logTruncated: record.logTruncated,
      reason: record.reason,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }
}
