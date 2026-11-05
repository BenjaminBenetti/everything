import type { Repository } from "@everything/persistence/repository";
import type {
  AgentJobChanges,
  AgentJobDefinition,
  ClaimedJobRun,
  DueJob,
  JobAdvance,
  JobMaintenanceScope,
  JobOwnerScope,
  JobRun,
  JobRunFinish,
  JobScope,
  NewAgentJob,
} from "../model/job.js";

/** Persistence boundary for teammate jobs and their operational runs. */
export interface AgentJobRepository extends Repository<
  AgentJobDefinition,
  JobScope
> {
  // Owner requests

  /** Save a job under the owned teammate's lock; refuses one beyond the per-teammate limit. */
  create(scope: JobOwnerScope, job: NewAgentJob): Promise<AgentJobDefinition>;
  /** Apply an owner's edit under the job's row lock; undefined when the job isn't in scope. */
  update(
    scope: JobOwnerScope,
    id: string,
    changes: AgentJobChanges,
  ): Promise<AgentJobDefinition | undefined>;
  /** Each listed job's most recent run, keyed by job ID. */
  latestRuns(
    scope: JobOwnerScope,
    jobIds: readonly string[],
  ): Promise<Map<string, JobRun>>;
  /** A job's most recent runs, newest first; empty when the job isn't in scope. */
  runs(scope: JobOwnerScope, jobId: string): Promise<JobRun[]>;
  /** Record a manual run at `at` unless one is active; refuses unknown jobs and overlap. */
  startNow(
    scope: JobOwnerScope,
    jobId: string,
    at: string,
  ): Promise<ClaimedJobRun>;

  // Scheduler

  /** Enabled jobs due by `now` that have no active run, earliest first. */
  due(scope: JobMaintenanceScope, now: Date, limit: number): Promise<DueJob[]>;
  /**
   * Recheck a due, enabled job under its row lock, record a pending run for its due time, and move
   * it to `advance(job)`, all in one transaction. Undefined when it's no longer due or a run is active.
   */
  claim(
    scope: JobMaintenanceScope,
    id: string,
    now: Date,
    advance: (job: AgentJobDefinition) => JobAdvance,
  ): Promise<ClaimedJobRun | undefined>;
  /** Fail every run still marked pending or running, for startup after a restart; returns how many. */
  interruptActive(
    scope: JobMaintenanceScope,
    finishedAt: string,
    error: string,
  ): Promise<number>;

  // Run lifecycle

  /** Mark a pending run as accepted by its teammate. */
  markRunning(
    scope: JobMaintenanceScope,
    runId: string,
    startedAt: string,
  ): Promise<void>;
  /** Record how an active run ended; a run already finished or deleted stays as it is. */
  finishRun(
    scope: JobMaintenanceScope,
    runId: string,
    finish: JobRunFinish,
  ): Promise<void>;
}

/** Owner operations behind the jobs API. */
export type JobStore = Pick<
  AgentJobRepository,
  | "getById"
  | "list"
  | "delete"
  | "create"
  | "update"
  | "latestRuns"
  | "runs"
  | "startNow"
>;

/** What the scheduler reads and claims. */
export type JobSchedulerStore = Pick<
  AgentJobRepository,
  "due" | "claim" | "interruptActive"
>;

/** How the dispatcher records a run's lifecycle. */
export type JobRunStore = Pick<AgentJobRepository, "markRunning" | "finishRun">;
