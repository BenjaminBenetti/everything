import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import { jobLimits, type AgentJobRecord } from "../model/job.js";

/** Map a teammate's jobs; deleting the teammate deletes its jobs and their runs. */
export const AgentJobEntity = new EntitySchema<AgentJobRecord>({
  name: "AgentJobRecord",
  tableName: "agent_jobs",
  columns: {
    ...baseColumns,
    agentId: { name: "agent_id", type: "uuid" },
    name: { type: "text" },
    instructions: { type: "text" },
    schedule: { type: "jsonb" },
    nextRunAt: {
      name: "next_run_at",
      type: "timestamptz",
      transformer: timestampTransformer,
    },
    enabled: { type: "boolean", default: true },
    updatedAt: {
      name: "updated_at",
      type: "timestamptz",
      transformer: timestampTransformer,
    },
  },
  relations: {
    agent: {
      type: "many-to-one",
      target: "AgentDefinition",
      nullable: false,
      onDelete: "CASCADE",
      joinColumn: {
        name: "agent_id",
        referencedColumnName: "id",
        foreignKeyConstraintName: "agent_jobs_agent_id_fkey",
      },
    },
  },
  indices: [
    { name: "agent_jobs_agent", columns: ["agentId", "createdAt"] },
    { name: "agent_jobs_due", columns: ["nextRunAt"], where: "enabled" },
  ],
  checks: [
    {
      name: "agent_jobs_name_check",
      expression: `length(name) BETWEEN 1 AND ${jobLimits.nameLength}`,
    },
    {
      name: "agent_jobs_instructions_check",
      expression: `length(instructions) BETWEEN 1 AND ${jobLimits.instructionsLength}`,
    },
    {
      name: "agent_jobs_schedule_check",
      expression:
        "jsonb_typeof(schedule) = 'object' AND schedule->>'type' IN ('once', 'interval', 'cron')",
    },
  ],
});
