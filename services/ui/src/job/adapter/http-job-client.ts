import type {
  AgentJob,
  AgentJobList,
  CreateJobInput,
  JobRun,
  JobRunList,
  JobSchedule,
  JobSchedulePreview,
  UpdateJobInput,
} from "@everything/agent-contracts/job";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import { HttpRequestError } from "../../http/model/http-request-error.js";
import type { JobClient } from "../interface/job-client.js";

/** What each job refusal means, since the transport keeps only the server's error code. */
const refusals: Readonly<Record<string, string>> = {
  JOB_SCHEDULE_INVALID:
    "This schedule can’t run as written. Check each cron field’s range, and keep runs at least five minutes apart.",
  JOB_SCHEDULE_PASSED:
    "This one-time job’s time has passed. Edit it to choose a future time, then resume it.",
  JOB_RUN_ACTIVE:
    "This job is already running. Wait for it to finish or stop it first.",
  JOB_LIMIT:
    "This teammate already has 25 jobs. Delete one before adding another.",
};

/** Translate job operations into the teammate jobs API. */
export class HttpJobClient implements JobClient {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive transport policy independently from the domain adapter. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read jobs, oldest first. */
  async list(agentId: string, signal?: AbortSignal): Promise<AgentJob[]> {
    const result = await this.send<AgentJobList>(
      this.collection(agentId),
      signal ? { signal } : {},
    );
    return result.jobs;
  }

  /** Save a job. */
  create(agentId: string, input: CreateJobInput): Promise<AgentJob> {
    return this.send(this.collection(agentId), {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Send only the changed fields. */
  update(
    agentId: string,
    jobId: string,
    input: UpdateJobInput,
  ): Promise<AgentJob> {
    return this.send(this.item(agentId, jobId), {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  /** Delete a job. */
  remove(agentId: string, jobId: string): Promise<void> {
    return this.send<void>(this.item(agentId, jobId), {
      method: "DELETE",
    });
  }

  /** Read recent runs. */
  async runs(
    agentId: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<JobRun[]> {
    const result = await this.send<JobRunList>(
      `${this.item(agentId, jobId)}/runs`,
      signal ? { signal } : {},
    );
    return result.runs;
  }

  /** Start a run. */
  runNow(agentId: string, jobId: string): Promise<JobRun> {
    return this.send(`${this.item(agentId, jobId)}/runs`, {
      method: "POST",
    });
  }

  /** Stop the current run. */
  stop(agentId: string, jobId: string): Promise<void> {
    return this.send<void>(`${this.item(agentId, jobId)}/stop`, {
      method: "POST",
    });
  }

  /** Check a schedule on the server, which owns the cron and timezone rules. */
  async preview(
    agentId: string,
    schedule: JobSchedule,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const result = await this.send<JobSchedulePreview>(
      `${this.collection(agentId)}/preview`,
      {
        method: "POST",
        body: JSON.stringify({ schedule }),
        ...(signal ? { signal } : {}),
      },
    );
    return result.nextRuns;
  }

  // ===========================================
  // Transport
  // ===========================================

  /** Make a request, describing job refusals in their own words. */
  private async send<T>(path: string, options?: RequestInit): Promise<T> {
    try {
      return await this.transport.request<T>(path, options);
    } catch (error) {
      const message =
        error instanceof HttpRequestError && error.code
          ? refusals[error.code]
          : undefined;
      if (message)
        throw new HttpRequestError(
          (error as HttpRequestError).status,
          message,
          (error as HttpRequestError).code,
        );
      throw error;
    }
  }

  // ===========================================
  // Paths
  // ===========================================

  /** The teammate's job collection. */
  private collection(agentId: string): string {
    return `/v1/agents/${encodeURIComponent(agentId)}/jobs`;
  }

  /** One job. */
  private item(agentId: string, jobId: string): string {
    return `${this.collection(agentId)}/${encodeURIComponent(jobId)}`;
  }
}
