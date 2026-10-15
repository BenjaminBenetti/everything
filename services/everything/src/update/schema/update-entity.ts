import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import { updateSummaryMaxLength } from "@everything/update-contracts";
import {
  storedSummaryStatuses,
  updateKinds,
  type UpdateRecord,
} from "../model/update-record.js";

/** Render allowed values as a SQL list for a check constraint. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/** Map directly owned updates; each kind's source reference cascades when its source is deleted. */
export const UpdateEntity = new EntitySchema<UpdateRecord>({
  name: "UpdateRecord",
  tableName: "updates",
  columns: {
    ...baseColumns,
    sequence: { type: "bigint", generated: "increment" },
    ownerId: { name: "owner_id", type: "text" },
    kind: { type: "text" },
    agentId: { name: "agent_id", type: "uuid", nullable: true },
    messageId: { name: "message_id", type: "uuid", nullable: true },
    summary: { type: "text", nullable: true },
    summaryStatus: { name: "summary_status", type: "text", default: "pending" },
    summaryStartedAt: {
      name: "summary_started_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
    readAt: {
      name: "read_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
  },
  relations: {
    agent: {
      type: "many-to-one",
      target: "AgentDefinition",
      nullable: true,
      onDelete: "CASCADE",
      joinColumn: {
        name: "agent_id",
        referencedColumnName: "id",
        foreignKeyConstraintName: "updates_agent_id_fkey",
      },
    },
    message: {
      type: "many-to-one",
      target: "MessageRecord",
      nullable: true,
      onDelete: "CASCADE",
      eager: true,
      joinColumn: {
        name: "message_id",
        referencedColumnName: "id",
        foreignKeyConstraintName: "updates_message_id_fkey",
      },
    },
  },
  uniques: [
    { name: "updates_sequence_key", columns: ["sequence"] },
    { name: "updates_message_id_key", columns: ["messageId"] },
  ],
  indices: [
    {
      name: "updates_unread",
      columns: ["ownerId", "sequence"],
      where: "read_at IS NULL",
    },
    {
      name: "updates_pending_summary",
      columns: ["createdAt", "sequence"],
      where: "read_at IS NULL AND summary_status = 'pending'",
    },
    { name: "updates_agent", columns: ["agentId"] },
  ],
  checks: [
    {
      name: "updates_kind_check",
      expression: `kind IN (${sqlList(updateKinds)})`,
    },
    {
      name: "updates_message_reference_check",
      expression:
        "kind <> 'message' OR (agent_id IS NOT NULL AND message_id IS NOT NULL)",
    },
    {
      name: "updates_summary_check",
      expression: `summary IS NULL OR length(summary) BETWEEN 1 AND ${updateSummaryMaxLength}`,
    },
    {
      name: "updates_summary_status_check",
      expression: `summary_status IN (${sqlList(storedSummaryStatuses)})`,
    },
  ],
});
