import { EntitySchema } from "typeorm";
import { timestampTransformer } from "@everything/persistence/schema";
import { jobLimits, type JobRunRecord } from "../model/job.js";

/**
 * Map each job's operational runs, deleted with their job. Only the approved columns are mapped, so
 * runs carry no creation, update, lease, or result fields. One row per occurrence, and at most one
 * pending or running row per job, are enforced by unique indexes.
 */
export const JobRunEntity = new EntitySchema<JobRunRecord>({
  name: "JobRunRecord",
  tableName: "agent_job_runs",
  columns: {
    id: { type: "uuid", primary: true },
    jobId: { name: "job_id", type: "uuid" },
    scheduledFor: {
      name: "scheduled_for",
      type: "timestamptz",
      transformer: timestampTransformer,
    },
    status: { type: "text" },
    startedAt: {
      name: "started_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
    finishedAt: {
      name: "finished_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
    error: { type: "text", nullable: true },
  },
  relations: {
    job: {
      type: "many-to-one",
      target: "AgentJobRecord",
      nullable: false,
      onDelete: "CASCADE",
      joinColumn: {
        name: "job_id",
        referencedColumnName: "id",
        foreignKeyConstraintName: "agent_job_runs_job_id_fkey",
      },
    },
  },
  uniques: [
    {
      name: "agent_job_runs_job_id_scheduled_for_key",
      columns: ["jobId", "scheduledFor"],
    },
  ],
  indices: [
    {
      name: "agent_job_runs_active",
      columns: ["jobId"],
      unique: true,
      where: "status IN ('pending', 'running')",
    },
  ],
  checks: [
    {
      name: "agent_job_runs_status_check",
      expression:
        "status IN ('pending', 'running', 'completed', 'failed', 'cancelled')",
    },
    {
      name: "agent_job_runs_lifecycle_check",
      expression:
        "(status = 'pending' AND started_at IS NULL AND finished_at IS NULL) OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL) OR (status IN ('completed', 'failed', 'cancelled') AND finished_at IS NOT NULL)",
    },
    {
      name: "agent_job_runs_error_check",
      expression: `error IS NULL OR length(error) BETWEEN 1 AND ${jobLimits.errorLength}`,
    },
  ],
});
