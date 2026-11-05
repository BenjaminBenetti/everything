import type { JobSchedulePreview } from "@everything/agent-contracts/job";
import type {
  AgentJob,
  CreateJobInput,
  JobOwnerScope,
  JobRun,
  JobSchedule,
  UpdateJobInput,
} from "../model/job.js";

/** Owner-scoped job use cases behind the jobs API. */
export interface JobOperations {
  /** List the teammate's jobs, each with its most recent run. */
  list(scope: JobOwnerScope): Promise<AgentJob[]>;
  /** Read one job of the teammate. */
  get(scope: JobOwnerScope, id: string): Promise<AgentJob>;
  /** Save a job with a checked schedule; it's due at its first time unless created paused. */
  create(scope: JobOwnerScope, input: CreateJobInput): Promise<AgentJob>;
  /** Change a job. Turning it off withdraws a run not yet accepted; a running one continues. */
  update(
    scope: JobOwnerScope,
    id: string,
    input: UpdateJobInput,
  ): Promise<AgentJob>;
  /** Delete a job and its runs, stopping only its own current run. */
  delete(scope: JobOwnerScope, id: string): Promise<void>;
  /** Read a job's recent runs, newest first. */
  runs(scope: JobOwnerScope, id: string): Promise<JobRun[]>;
  /** Start a run now as a separate occurrence; refused while another run of the job is active. */
  runNow(scope: JobOwnerScope, id: string): Promise<JobRun>;
  /** Stop the job's current run, if any, without pausing the job. */
  stop(scope: JobOwnerScope, id: string): Promise<void>;
  /** Check a schedule and return its next times without saving anything. */
  preview(
    scope: JobOwnerScope,
    schedule: JobSchedule,
  ): Promise<JobSchedulePreview>;
}
