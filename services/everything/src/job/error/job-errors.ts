import { ApplicationError } from "@everything/errors";
import { jobLimits } from "../model/job.js";

/** Unknown jobs and jobs of other teammates or owners look the same. */
export class JobNotFoundError extends ApplicationError {
  /** Don't reveal whether the job exists elsewhere. */
  constructor() {
    super(404, "JOB_NOT_FOUND", "This job wasn't found.");
  }
}

/** A schedule that can't run as written; the message says what to change. */
export class JobScheduleError extends ApplicationError {
  /** Explain the specific problem, never echoing more than the caller sent. */
  constructor(message: string) {
    super(400, "JOB_SCHEDULE_INVALID", message);
  }
}

/** A one-time job can't be resumed or saved once its time has passed. */
export class JobSchedulePassedError extends ApplicationError {
  /** Ask for a future time instead of running a stale job. */
  constructor() {
    super(
      409,
      "JOB_SCHEDULE_PASSED",
      "This one-time job's time has passed. Choose a future time before turning it back on.",
    );
  }
}

/** Keep each teammate's scheduled work bounded. */
export class JobLimitError extends ApplicationError {
  /** Name the limit and how to make room. */
  constructor() {
    super(
      409,
      "JOB_LIMIT",
      `This teammate already has ${jobLimits.jobsPerTeammate} jobs. Delete one before adding another.`,
    );
  }
}

/** Runs of the same job never overlap. */
export class JobRunActiveError extends ApplicationError {
  /** Offer the two ways forward. */
  constructor() {
    super(
      409,
      "JOB_RUN_ACTIVE",
      "This job is already running. Wait for it to finish or stop it first.",
    );
  }
}
