import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import { attachmentLimits } from "../model/attachment.js";
import type { AttachmentRecord } from "../model/attachment.js";

/**
 * Map attachments to the teammate that owns them and, once sent, the message that carries them. Both
 * relations cascade, so deleting a teammate removes its attachment records with its messages.
 */
export const AttachmentEntity = new EntitySchema<AttachmentRecord>({
  name: "AttachmentRecord",
  tableName: "attachments",
  columns: {
    ...baseColumns,
    agentId: { name: "agent_id", type: "uuid" },
    messageId: { name: "message_id", type: "uuid", nullable: true },
    position: { type: "smallint", nullable: true },
    name: { type: "text" },
    size: { type: "integer" },
    received: { type: "integer" },
    status: { type: "text" },
    kind: { type: "text", nullable: true },
    mediaType: { name: "media_type", type: "text", nullable: true },
    path: { type: "text" },
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
        foreignKeyConstraintName: "attachments_agent_id_fkey",
      },
    },
    message: {
      type: "many-to-one",
      target: "MessageRecord",
      inverseSide: "attachments",
      nullable: true,
      onDelete: "CASCADE",
      joinColumn: {
        name: "message_id",
        referencedColumnName: "id",
        foreignKeyConstraintName: "attachments_message_id_fkey",
      },
    },
  },
  indices: [
    { name: "attachments_agent_message", columns: ["agentId", "messageId"] },
    {
      name: "attachments_message_position",
      columns: ["messageId", "position"],
    },
  ],
  checks: [
    {
      name: "attachments_name_check",
      expression: `length(name) BETWEEN 1 AND ${attachmentLimits.nameLength}`,
    },
    {
      name: "attachments_size_check",
      expression: `size BETWEEN 0 AND ${attachmentLimits.maxFileBytes} AND received BETWEEN 0 AND size`,
    },
    {
      name: "attachments_status_check",
      expression:
        "(status = 'uploading' AND message_id IS NULL) OR (status = 'ready' AND received = size AND kind IS NOT NULL AND media_type IS NOT NULL)",
    },
    {
      name: "attachments_kind_check",
      expression: "kind IS NULL OR kind IN ('image', 'text', 'binary')",
    },
  ],
});
