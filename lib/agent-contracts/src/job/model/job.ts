/** Run once at an exact instant; the instant must carry a UTC offset or `Z`. */
export interface OnceJobSchedule {
  readonly type: "once";
  readonly at: string;
}

/** Run repeatedly, a whole number of seconds apart. */
export interface IntervalJobSchedule {
  readonly type: "interval";
  readonly seconds: number;
}

/** Run when a five-field numeric cron expression matches the wall clock in an IANA timezone. */
export interface CronJobSchedule {
  readonly type: "cron";
  readonly expression: string;
  readonly timezone: string;
}

/** When a job wakes its teammate. */
export type JobSchedule =
  OnceJobSchedule | IntervalJobSchedule | CronJobSchedule;

/** Operational lifecycle of one run; it never records what the teammate found. */
export type JobRunStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled";

/** Statuses that keep later runs of the same job from starting. */
export const activeJobRunStatuses = [
  "pending",
  "running",
] as const satisfies readonly JobRunStatus[];

/** One scheduled or manual occurrence of a job. */
export interface JobRun {
  readonly id: string;
  readonly jobId: string;
  /** The occurrence this run handles: the due time, or the moment Run now was pressed. */
  readonly scheduledFor: string;
  readonly status: JobRunStatus;
  /** When the teammate accepted the run as background work. */
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** A short, safe operational reason for a failed or cancelled run. */
  readonly error: string | null;
}

/** A teammate's saved job, with its most recent run for list views. */
export interface AgentJob {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly instructions: string;
  readonly schedule: JobSchedule;
  /** The next time the job is due; null while it is paused. */
  readonly nextRunAt: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  /** When the owner last changed the job. */
  readonly updatedAt: string;
  readonly latestRun: JobRun | null;
}

/** A teammate's jobs, oldest first. */
export interface AgentJobList {
  readonly jobs: AgentJob[];
}

/** Recent runs of one job, newest first. */
export interface JobRunList {
  readonly runs: JobRun[];
}

/** Fields an owner supplies to create a job; it starts enabled unless `enabled` is false. */
export interface CreateJobInput {
  readonly name: string;
  readonly instructions: string;
  readonly schedule: JobSchedule;
  readonly enabled?: boolean;
}

/** Change any subset of a job. `enabled: false` pauses future runs; it doesn't stop a current run. */
export interface UpdateJobInput {
  readonly name?: string;
  readonly instructions?: string;
  readonly schedule?: JobSchedule;
  readonly enabled?: boolean;
}

/** The next times a schedule would run, computed by the server before saving. */
export interface JobSchedulePreview {
  readonly nextRuns: string[];
}

/** Shared bounds for job requests, storage checks, and forms. */
export const jobLimits = {
  nameLength: 100,
  instructionsLength: 8_000,
  /** Runs of one job, or cron matches, at least five minutes apart. */
  minIntervalSeconds: 300,
  maxIntervalSeconds: 31_536_000,
  /** A one-time job can be at most about five years ahead. */
  maxOnceAheadMs: 5 * 366 * 86_400_000,
  cronLength: 100,
  timezoneLength: 64,
  jobsPerTeammate: 25,
  /** Runs one listing returns, newest first. */
  recentRuns: 20,
  /** Runs kept per job; older finished runs are removed as new ones start. */
  retainedRuns: 100,
  /** Longest stored operational error. */
  errorLength: 500,
  previewRuns: 3,
} as const;
