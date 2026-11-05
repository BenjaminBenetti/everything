import type { AgentJob, AgentJobDefinition, JobRun } from "../model/job.js";

/** Show a job with its latest run; a paused job has no next run. */
export function representJob(
  job: AgentJobDefinition,
  latestRun: JobRun | null,
): AgentJob {
  return {
    id: job.id,
    agentId: job.agentId,
    name: job.name,
    instructions: job.instructions,
    schedule: job.schedule,
    nextRunAt: job.enabled ? job.nextRunAt : null,
    enabled: job.enabled,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    latestRun,
  };
}
