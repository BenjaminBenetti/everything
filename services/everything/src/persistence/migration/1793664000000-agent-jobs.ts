import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/**
 * Add teammate jobs and their operational runs: two empty tables, with no seeded or backfilled jobs.
 * A run row is one occurrence of a job; at most one run of a job is pending or running at a time.
 */
export class AgentJobs1793664000000 implements MigrationInterface {
  /** Create both tables with their keys, indexes, and checks. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "agent_jobs",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            primaryKeyConstraintName: "agent_jobs_pkey",
          },
          { name: "agent_id", type: "uuid" },
          { name: "name", type: "text" },
          { name: "instructions", type: "text" },
          { name: "schedule", type: "jsonb" },
          { name: "next_run_at", type: "timestamptz" },
          { name: "enabled", type: "boolean", default: true },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "updated_at", type: "timestamptz" },
        ],
        indices: [
          { name: "agent_jobs_agent", columnNames: ["agent_id", "created_at"] },
          {
            name: "agent_jobs_due",
            columnNames: ["next_run_at"],
            where: "enabled",
          },
        ],
        foreignKeys: [
          {
            name: "agent_jobs_agent_id_fkey",
            columnNames: ["agent_id"],
            referencedTableName: "agents",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
        checks: [
          {
            name: "agent_jobs_name_check",
            expression: "length(name) BETWEEN 1 AND 100",
          },
          {
            name: "agent_jobs_instructions_check",
            expression: "length(instructions) BETWEEN 1 AND 8000",
          },
          {
            name: "agent_jobs_schedule_check",
            expression:
              "jsonb_typeof(schedule) = 'object' AND schedule->>'type' IN ('once', 'interval', 'cron')",
          },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "agent_job_runs",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            primaryKeyConstraintName: "agent_job_runs_pkey",
          },
          { name: "job_id", type: "uuid" },
          { name: "scheduled_for", type: "timestamptz" },
          { name: "status", type: "text" },
          { name: "started_at", type: "timestamptz", isNullable: true },
          { name: "finished_at", type: "timestamptz", isNullable: true },
          { name: "error", type: "text", isNullable: true },
        ],
        uniques: [
          {
            name: "agent_job_runs_job_id_scheduled_for_key",
            columnNames: ["job_id", "scheduled_for"],
          },
        ],
        indices: [
          {
            name: "agent_job_runs_active",
            columnNames: ["job_id"],
            isUnique: true,
            where: "status IN ('pending', 'running')",
          },
        ],
        foreignKeys: [
          {
            name: "agent_job_runs_job_id_fkey",
            columnNames: ["job_id"],
            referencedTableName: "agent_jobs",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
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
            expression: "error IS NULL OR length(error) BETWEEN 1 AND 500",
          },
        ],
      }),
    );
  }

  /** Remove runs, then jobs, on an explicit rollback. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("agent_job_runs");
    await runner.dropTable("agent_jobs");
  }
}
