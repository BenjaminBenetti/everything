import { EntitySchema } from "typeorm";
import { baseColumns } from "@everything/persistence/schema";
import { messageTextMaxLength } from "../model/message.js";
import type { MessageRecord } from "../model/message-record.js";

/** Map visible messages, the agent relation carrying ownership, and the files sent with them. */
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
    attachments: {
      type: "one-to-many",
      target: "AttachmentRecord",
      inverseSide: "message",
    },
  },
  indices: [
    { name: "messages_agent_sequence", columns: ["agentId", "sequence"] },
  ],
  uniques: [{ name: "messages_sequence_key", columns: ["sequence"] }],
  checks: [
    {
      name: "messages_role_check",
      expression: "role IN ('user', 'assistant')",
    },
    {
      // A user message may carry only attachments; teammate replies always have text.
      name: "messages_text_check",
      expression: `length(text) <= ${messageTextMaxLength} AND (role = 'user' OR length(text) >= 1)`,
    },
  ],
});
