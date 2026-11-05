import type {
  AgentJob,
  CreateJobInput,
  JobRun,
  JobSchedule,
  UpdateJobInput,
} from "@everything/agent-contracts/job";

/** A teammate's scheduled jobs and their run history. */
export interface JobClient {
  /** Read the teammate's jobs, each with its latest run. */
  list(agentId: string, signal?: AbortSignal): Promise<AgentJob[]>;
  /** Save a new job. */
  create(agentId: string, input: CreateJobInput): Promise<AgentJob>;
  /** Change a job; `enabled: false` pauses later runs. */
  update(
    agentId: string,
    jobId: string,
    input: UpdateJobInput,
  ): Promise<AgentJob>;
  /** Delete a job, its history, and its current run. */
  remove(agentId: string, jobId: string): Promise<void>;
  /** Read a job's recent runs, newest first. */
  runs(agentId: string, jobId: string, signal?: AbortSignal): Promise<JobRun[]>;
  /** Start a separate run now. */
  runNow(agentId: string, jobId: string): Promise<JobRun>;
  /** Stop the job's current run without pausing it. */
  stop(agentId: string, jobId: string): Promise<void>;
  /** Check a schedule and read its next times. */
  preview(
    agentId: string,
    schedule: JobSchedule,
    signal?: AbortSignal,
  ): Promise<string[]>;
}
