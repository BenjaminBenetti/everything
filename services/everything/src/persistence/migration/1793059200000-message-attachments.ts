import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/**
 * Record files the user attaches for a teammate. The files live in the teammate's workspace; this
 * table holds only their server-chosen paths and a few facts about them. A user message may now
 * carry only attachments, so its text may be empty; teammate replies still need text.
 */
export class MessageAttachments1793059200000 implements MigrationInterface {
  /** Create the attachments table and allow empty text on user messages. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "attachments",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            primaryKeyConstraintName: "attachments_pkey",
          },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "agent_id", type: "uuid" },
          { name: "message_id", type: "uuid", isNullable: true },
          { name: "position", type: "smallint", isNullable: true },
          { name: "name", type: "text" },
          { name: "size", type: "integer" },
          { name: "received", type: "integer" },
          { name: "status", type: "text" },
          { name: "kind", type: "text", isNullable: true },
          { name: "media_type", type: "text", isNullable: true },
          { name: "path", type: "text" },
          { name: "updated_at", type: "timestamptz" },
        ],
        indices: [
          {
            name: "attachments_agent_message",
            columnNames: ["agent_id", "message_id"],
          },
          {
            name: "attachments_message_position",
            columnNames: ["message_id", "position"],
          },
        ],
        foreignKeys: [
          {
            name: "attachments_agent_id_fkey",
            columnNames: ["agent_id"],
            referencedTableName: "agents",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
          {
            name: "attachments_message_id_fkey",
            columnNames: ["message_id"],
            referencedTableName: "messages",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
        checks: [
          {
            name: "attachments_name_check",
            expression: "length(name) BETWEEN 1 AND 255",
          },
          {
            name: "attachments_size_check",
            expression:
              "size BETWEEN 0 AND 26214400 AND received BETWEEN 0 AND size",
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
      }),
    );
    await runner.query(
      "ALTER TABLE messages DROP CONSTRAINT messages_text_check, ADD CONSTRAINT messages_text_check CHECK (length(text) <= 32000 AND (role = 'user' OR length(text) >= 1))",
    );
  }

  /** Remove attachments on an explicit rollback; attachment-only messages must be removed first. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      "ALTER TABLE messages DROP CONSTRAINT messages_text_check, ADD CONSTRAINT messages_text_check CHECK (length(text) BETWEEN 1 AND 32000)",
    );
    await runner.dropTable("attachments");
  }
}
