import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import { SubagentNotFoundError } from "../../subagent/error/subagent-errors.js";
import type {
  WakeupObserver,
  WakeupOptions,
} from "../../subagent/interface/subagent-operations.js";
import {
  JobLimitError,
  JobNotFoundError,
  JobRunActiveError,
} from "../error/job-errors.js";
import type { AgentJobRepository } from "../interface/job-repository.js";
import {
  activeJobRunStatuses,
  jobLimits,
  type AgentJobChanges,
  type AgentJobDefinition,
  type ClaimedJobRun,
  type DueJob,
  type JobAdvance,
  type JobMaintenanceScope,
  type JobOwnerScope,
  type JobRun,
  type JobRunFinish,
  type JobScope,
  type NewAgentJob,
} from "../model/job.js";
import type { JobWakeups } from "../service/job-runs.js";

/** Fixed teammates: two owned by `owner`, one by `other`. */
export const teammates = {
  avery: "5d0c6a52-8b8e-4c55-9c1a-3f1d2e7b9a10",
  blake: "7a3e1c90-2b4f-4d6e-8a1c-5f9e0d2c4b31",
  foreign: "c2d4e6f8-1a3b-4c5d-9e7f-0a1b2c3d4e5f",
} as const;

/** Owner of each fixture teammate. */
export const owners: Readonly<Record<string, string>> = {
  [teammates.avery]: "owner",
  [teammates.blake]: "owner",
  [teammates.foreign]: "other",
};

/** A manual clock that tests advance explicitly. */
export class FakeClock {
  // ===========================================
  // State
  // ===========================================

  private current: number;

  /** Start at a fixed instant. */
  constructor(start = "2026-11-05T10:00:00.000Z") {
    this.current = Date.parse(start);
  }

  // ===========================================
  // Operations
  // ===========================================

  /** The current instant as a new Date. */
  readonly now = (): Date => new Date(this.current);

  /** Move forward by milliseconds. */
  advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  /** Jump to an instant. */
  set(instant: string): void {
    this.current = Date.parse(instant);
  }
}

/** Resolve teammates from the fixed owner map, hiding others' teammates as PostgreSQL scope would. */
export function fixtureAgents(): Pick<AgentCatalog, "get"> {
  return {
    async get(ownerId, id) {
      if (owners[id] !== ownerId) throw new AgentNotFoundError();
      return {
        id,
        ownerId,
        name: "Avery",
        systemPrompt: "Help",
        avatarId: "avatar-03",
        inference: null,
        createdAt: "2026-11-01T00:00:00.000Z",
      } satisfies AgentDefinition;
    },
  };
}

/**
 * In-memory jobs and runs applying the PostgreSQL repository's rules: owner scope through the
 * teammate, the per-teammate limit, one row per occurrence, at most one active run per job, claims
 * that recheck due state, ordered pruning, and lifecycle updates that only move forward.
 */
export class MemoryJobs implements AgentJobRepository {
  // ===========================================
  // State
  // ===========================================

  readonly jobs = new Map<string, AgentJobDefinition>();
  readonly runRecords: JobRun[] = [];

  /** Accept the teammate owner map and the clock used for timestamps. */
  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly agentOwners: Readonly<Record<string, string>> = owners,
  ) {}

  // ===========================================
  // Base repository
  // ===========================================

  /** Find a job in scope. */
  async getById(scope: JobScope, id: string) {
    const job = this.jobs.get(id);
    return job && this.inScope(scope, job) ? { ...job } : undefined;
  }

  /** The teammate's jobs, oldest first. */
  async list(scope: JobScope) {
    return [...this.jobs.values()]
      .filter((job) => this.inScope(scope, job))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((job) => ({ ...job }));
  }

  /** Remove a job in scope and cascade its runs. */
  async delete(scope: JobScope, id: string) {
    const job = this.jobs.get(id);
    if (!job || !this.inScope(scope, job)) return;
    this.jobs.delete(id);
    this.removeRuns((run) => run.jobId === id);
  }

  // ===========================================
  // Owner requests
  // ===========================================

  /** Insert after the owner and limit checks. */
  async create(scope: JobOwnerScope, job: NewAgentJob) {
    if (this.agentOwners[scope.agentId] !== scope.ownerId)
      throw new AgentNotFoundError();
    if (
      [...this.jobs.values()].filter((item) => item.agentId === scope.agentId)
        .length >= jobLimits.jobsPerTeammate
    )
      throw new JobLimitError();
    const now = this.clock().toISOString();
    const saved: AgentJobDefinition = {
      ...job,
      id: randomUUID(),
      agentId: scope.agentId,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(saved.id, saved);
    return { ...saved };
  }

  /** Apply only supplied fields. */
  async update(scope: JobOwnerScope, id: string, changes: AgentJobChanges) {
    const job = this.jobs.get(id);
    if (!job || !this.inScope(scope, job)) return undefined;
    const updated = { ...job, ...changes };
    this.jobs.set(id, updated);
    return { ...updated };
  }

  /** Latest run per listed job, in scope. */
  async latestRuns(scope: JobOwnerScope, jobIds: readonly string[]) {
    const latest = new Map<string, JobRun>();
    for (const id of jobIds) {
      const job = this.jobs.get(id);
      if (!job || !this.inScope(scope, job)) continue;
      const [run] = this.runsOf(id);
      if (run) latest.set(id, { ...run });
    }
    return latest;
  }

  /** Newest first, bounded. */
  async runs(scope: JobOwnerScope, jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job || !this.inScope(scope, job)) return [];
    return this.runsOf(jobId)
      .slice(0, jobLimits.recentRuns)
      .map((run) => ({ ...run }));
  }

  /** Manual run unless one is active or the instant is taken. */
  async startNow(scope: JobOwnerScope, jobId: string, at: string) {
    const job = this.jobs.get(jobId);
    if (!job || !this.inScope(scope, job)) throw new JobNotFoundError();
    if (this.hasActive(jobId)) throw new JobRunActiveError();
    if (
      this.runRecords.some(
        (run) => run.jobId === jobId && run.scheduledFor === at,
      )
    )
      throw new JobRunActiveError();
    return this.claimed(job, this.insertRun(jobId, at), true);
  }

  // ===========================================
  // Scheduler
  // ===========================================

  /** Enabled, due, and idle, earliest first. */
  async due(scope: JobMaintenanceScope, now: Date, limit: number) {
    this.requireMaintenance(scope);
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.enabled &&
          Date.parse(job.nextRunAt) <= now.getTime() &&
          !this.hasActive(job.id),
      )
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, limit)
      .map(({ id, nextRunAt }): DueJob => ({ id, nextRunAt }));
  }

  /** Recheck, record, and advance atomically, as the row-locked transaction does. */
  async claim(
    scope: JobMaintenanceScope,
    id: string,
    now: Date,
    advance: (job: AgentJobDefinition) => JobAdvance,
  ): Promise<ClaimedJobRun | undefined> {
    this.requireMaintenance(scope);
    const job = this.jobs.get(id);
    if (
      !job ||
      !job.enabled ||
      Date.parse(job.nextRunAt) > now.getTime() ||
      this.hasActive(id)
    )
      return undefined;
    const handled = this.runRecords.some(
      (run) => run.jobId === id && run.scheduledFor === job.nextRunAt,
    );
    const run = handled ? undefined : this.insertRun(id, job.nextRunAt);
    const next = advance({ ...job });
    this.jobs.set(id, { ...job, ...next });
    return run && this.claimed(job, run, false);
  }

  /** Fail everything still active. */
  async interruptActive(
    scope: JobMaintenanceScope,
    finishedAt: string,
    error: string,
  ) {
    this.requireMaintenance(scope);
    let count = 0;
    for (const [index, run] of this.runRecords.entries())
      if (this.isActive(run)) {
        this.runRecords[index] = {
          ...run,
          status: "failed",
          finishedAt,
          error,
        };
        count++;
      }
    return count;
  }

  // ===========================================
  // Run lifecycle
  // ===========================================

  /** Pending to running only. */
  async markRunning(
    scope: JobMaintenanceScope,
    runId: string,
    startedAt: string,
  ) {
    this.requireMaintenance(scope);
    const index = this.runRecords.findIndex(
      (run) => run.id === runId && run.status === "pending",
    );
    if (index >= 0)
      this.runRecords[index] = {
        ...this.runRecords[index]!,
        status: "running",
        startedAt,
      };
  }

  /** Active to finished only. */
  async finishRun(
    scope: JobMaintenanceScope,
    runId: string,
    finish: JobRunFinish,
  ) {
    this.requireMaintenance(scope);
    const index = this.runRecords.findIndex(
      (run) => run.id === runId && this.isActive(run),
    );
    if (index < 0) return;
    const run = this.runRecords[index]!;
    this.runRecords[index] = {
      ...run,
      status: finish.status,
      finishedAt: finish.finishedAt,
      error: finish.error,
      startedAt: finish.startedAt ?? run.startedAt,
    };
  }

  // ===========================================
  // Test helpers
  // ===========================================

  /** A run by ID. */
  run(id: string): JobRun {
    const run = this.runRecords.find((item) => item.id === id);
    assert.ok(run, `run ${id} exists`);
    return run;
  }

  /** All runs of a job, newest first. */
  runsOf(jobId: string): JobRun[] {
    return this.runRecords
      .filter((run) => run.jobId === jobId)
      .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor));
  }

  // ===========================================
  // Rules
  // ===========================================

  /** Owner requests see one owned teammate; maintenance must be explicit. */
  private inScope(scope: JobScope, job: AgentJobDefinition): boolean {
    if ("ownership" in scope) {
      this.requireMaintenance(scope);
      return true;
    }
    return (
      job.agentId === scope.agentId &&
      this.agentOwners[job.agentId] === scope.ownerId
    );
  }

  /** Refuse anything but the named maintenance scope. */
  private requireMaintenance(scope: JobMaintenanceScope): void {
    assert.equal(scope.ownership, "all");
  }

  /** Whether the run blocks another. */
  private isActive(run: JobRun): boolean {
    return (activeJobRunStatuses as readonly string[]).includes(run.status);
  }

  /** Whether the job has an active run. */
  private hasActive(jobId: string): boolean {
    return this.runRecords.some(
      (run) => run.jobId === jobId && this.isActive(run),
    );
  }

  /** Insert under both unique rules, then prune finished runs beyond retention. */
  private insertRun(jobId: string, scheduledFor: string): JobRun {
    assert.ok(!this.hasActive(jobId), "agent_job_runs_active");
    assert.ok(
      !this.runRecords.some(
        (run) => run.jobId === jobId && run.scheduledFor === scheduledFor,
      ),
      "agent_job_runs_job_id_scheduled_for_key",
    );
    const run: JobRun = {
      id: randomUUID(),
      jobId,
      scheduledFor,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    this.runRecords.push(run);
    const cutoff = this.runsOf(jobId)[jobLimits.retainedRuns];
    if (cutoff)
      this.removeRuns(
        (item) =>
          item.jobId === jobId &&
          item.scheduledFor <= cutoff.scheduledFor &&
          !this.isActive(item),
      );
    return { ...run };
  }

  /** Remove matching runs in place. */
  private removeRuns(matches: (run: JobRun) => boolean): void {
    for (let index = this.runRecords.length - 1; index >= 0; index--)
      if (matches(this.runRecords[index]!)) this.runRecords.splice(index, 1);
  }

  /** The claimed run and its job snapshot. */
  private claimed(
    job: AgentJobDefinition,
    run: JobRun,
    manual: boolean,
  ): ClaimedJobRun {
    return {
      run,
      ownerId: this.agentOwners[job.agentId]!,
      job: {
        id: job.id,
        agentId: job.agentId,
        name: job.name,
        instructions: job.instructions,
        schedule: job.schedule,
      },
      manual,
    };
  }
}

/** One wakeup the fake runtime received. */
export interface FakeWakeup {
  readonly scope: JobOwnerScope;
  readonly task: string;
  readonly context: boolean;
  readonly options: WakeupOptions | undefined;
  readonly id: string;
  readonly observer: WakeupObserver | undefined;
}

/**
 * A scriptable stand-in for the teammate runtime: each wakeup is accepted (calling the observer's
 * `accepted` synchronously, as the real runtime does) or refused with a queued error, and tests end
 * accepted sessions explicitly. Deletion ends a session as cancelled, as subtree removal does.
 */
export class FakeWakeups implements JobWakeups {
  // ===========================================
  // State
  // ===========================================

  readonly accepted: FakeWakeup[] = [];
  readonly refusedCount = { value: 0 };
  readonly deleted: string[] = [];
  private readonly refusals: unknown[] = [];
  private readonly live = new Set<string>();

  // ===========================================
  // Script
  // ===========================================

  /** Refuse the next wakeups, in order, with these errors. */
  refuse(...errors: unknown[]): void {
    this.refusals.push(...errors);
  }

  /** End an accepted session the way its removal would report it. */
  end(id: string, outcome: "completed" | "failed" | "cancelled"): void {
    const wakeup = this.accepted.find((item) => item.id === id);
    assert.ok(wakeup && this.live.delete(id), `session ${id} is live`);
    wakeup.observer?.finished(outcome);
  }

  /** The most recent accepted wakeup. */
  get last(): FakeWakeup {
    const wakeup = this.accepted.at(-1);
    assert.ok(wakeup, "a wakeup was accepted");
    return wakeup;
  }

  // ===========================================
  // Runtime operations
  // ===========================================

  /** Accept or refuse, honoring an already-aborted signal as the service's lock check does. */
  async wakeup(
    scope: JobOwnerScope,
    input: { task: string; context?: boolean },
    signal?: AbortSignal,
    options?: WakeupOptions,
  ) {
    signal?.throwIfAborted();
    const refusal = this.refusals.shift();
    if (refusal !== undefined) {
      this.refusedCount.value++;
      throw refusal;
    }
    const id = randomUUID();
    this.accepted.push({
      scope,
      task: input.task,
      context: input.context ?? false,
      options,
      id,
      observer: options?.observer,
    });
    this.live.add(id);
    options?.observer?.accepted(id);
    return { id, parentId: "main", status: "running" as const };
  }

  /** Remove a live session, reporting it cancelled; unknown sessions are missing. */
  async delete(_scope: JobOwnerScope, id: string) {
    if (!this.live.has(id)) throw new SubagentNotFoundError();
    this.deleted.push(id);
    this.end(id, "cancelled");
  }
}

/** Let queued promise work settle without timers. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
