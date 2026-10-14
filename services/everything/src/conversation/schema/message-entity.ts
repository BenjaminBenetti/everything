import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import { messageTextMaxLength } from "../model/message.js";
import type { MessageRecord } from "../model/message-record.js";

/** Map visible messages and the agent relation carrying ownership. */
export const MessageEntity = new EntitySchema<MessageRecord>({
  name: "MessageRecord",
  tableName: "messages",
  columns: {
    ...baseColumns,
    agentId: { name: "agent_id", type: "uuid" },
    sequence: {
      type: "bigint",
      generated: "increment",
    },
    updateSummary: { name: "update_summary", type: "text", nullable: true },
    summaryStatus: { name: "summary_status", type: "text", default: "pending" },
    summaryStartedAt: {
      name: "summary_started_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
    role: { type: "text" },
    text: { type: "text" },
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
      nullable: false,
      onDelete: "CASCADE",
      joinColumn: {
        name: "agent_id",
        referencedColumnName: "id",
        foreignKeyConstraintName: "messages_agent_id_fkey",
      },
    },
  },
  indices: [
    {
      name: "messages_pending_summary",
      columns: ["createdAt", "sequence"],
      where:
        "role = 'assistant' AND read_at IS NULL AND summary_status = 'pending'",
    },
    { name: "messages_agent_sequence", columns: ["agentId", "sequence"] },
    {
      name: "messages_unread",
      columns: ["agentId", "sequence"],
      where: "role = 'assistant' AND read_at IS NULL",
    },
  ],
  uniques: [{ name: "messages_sequence_key", columns: ["sequence"] }],
  checks: [
    {
      name: "messages_summary_status_check",
      expression:
        "summary_status IN ('pending', 'generating', 'ready', 'failed')",
    },
    {
      name: "messages_update_summary_check",
      expression:
        "update_summary IS NULL OR length(update_summary) BETWEEN 1 AND 280",
    },
    {
      name: "messages_role_check",
      expression: "role IN ('user', 'assistant')",
    },
    {
      name: "messages_text_check",
      expression: `length(text) BETWEEN 1 AND ${messageTextMaxLength}`,
    },
  ],
});
