import type { BaseEntity } from "@everything/persistence/entity";
import type { OwnerScope } from "@everything/persistence/repository";
import type {
  JobRun,
  JobRunStatus,
  JobSchedule,
} from "@everything/agent-contracts/job";
import type { AgentDefinition } from "../../agent/model/agent.js";
export {
  activeJobRunStatuses,
  jobLimits,
  type AgentJob,
  type CreateJobInput,
  type JobRun,
  type JobRunStatus,
  type JobSchedule,
  type UpdateJobInput,
} from "@everything/agent-contracts/job";

/** A teammate's saved job; the teammate supplies its owner. */
export interface AgentJobDefinition extends BaseEntity {
  readonly agentId: string;
  readonly name: string;
  readonly instructions: string;
  readonly schedule: JobSchedule;
  /** The next due time in UTC; kept, but not due, while the job is paused. */
  readonly nextRunAt: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/** Ownership follows the teammate relation. */
export interface AgentJobRecord extends AgentJobDefinition {
  readonly agent?: AgentDefinition;
}

/**
 * Runs belong to their job and are reached only through the job repository. The approved schema
 * gives them no creation column, so they aren't `BaseEntity`s; `scheduledFor` orders them instead.
 */
export interface JobRunRecord extends JobRun {
  readonly job?: AgentJobRecord;
}

/** Limit job access to one teammate owned by the authenticated subject. */
export interface JobOwnerScope extends OwnerScope {
  readonly agentId: string;
}

/** Explicit internal scope for the scheduler and run bookkeeping; never used by owner requests. */
export interface JobMaintenanceScope {
  readonly ownership: "all";
}

export type JobScope = JobOwnerScope | JobMaintenanceScope;

/** The maintenance scope, named once so internal callers can't omit it. */
export const allJobs: JobMaintenanceScope = { ownership: "all" };

/** A job with its schedule checked and its first due time computed. */
export interface NewAgentJob {
  readonly name: string;
  readonly instructions: string;
  readonly schedule: JobSchedule;
  readonly nextRunAt: string;
  readonly enabled: boolean;
}

/** Fields an owner's edit changes; omitted fields stay as they are. */
export interface AgentJobChanges {
  readonly name?: string;
  readonly instructions?: string;
  readonly schedule?: JobSchedule;
  readonly nextRunAt?: string;
  readonly enabled?: boolean;
  readonly updatedAt: string;
}

/** Where a claimed occurrence moves its job: the next due time, or disabled after a last run. */
export interface JobAdvance {
  readonly nextRunAt: string;
  readonly enabled: boolean;
}

/** A due job the scheduler may try to claim. */
export interface DueJob {
  readonly id: string;
  readonly nextRunAt: string;
}

/** A newly recorded run and the job definition it runs, read in the same transaction. */
export interface ClaimedJobRun {
  readonly run: JobRun;
  readonly ownerId: string;
  readonly job: Pick<
    AgentJobDefinition,
    "id" | "agentId" | "name" | "instructions" | "schedule"
  >;
  /** True for Run now; false for a scheduled occurrence. Not stored. */
  readonly manual: boolean;
}

/** How a run ended, as recorded when it finishes. */
export interface JobRunFinish {
  readonly status: Extract<JobRunStatus, "completed" | "failed" | "cancelled">;
  readonly finishedAt: string;
  /** When the teammate accepted the run, if it did. */
  readonly startedAt: string | null;
  readonly error: string | null;
}
