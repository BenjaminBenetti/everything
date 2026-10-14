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
      name: "messages_role_check",
      expression: "role IN ('user', 'assistant')",
    },
    {
      name: "messages_text_check",
      expression: `length(text) BETWEEN 1 AND ${messageTextMaxLength}`,
    },
  ],
});
