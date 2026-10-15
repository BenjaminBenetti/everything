import {
  Table,
  TableCheck,
  TableForeignKey,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from "typeorm";

/**
 * Store updates as directly owned records of any kind. Each kind adds typed references to its source,
 * which cascade on deletion. Existing messages get no updates, the same as having been read.
 */
export class Updates1792281600000 implements MigrationInterface {
  /** Create the updates table with its source references, summary state, and partial work indexes. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "updates",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            primaryKeyConstraintName: "updates_pkey",
          },
          {
            name: "sequence",
            type: "bigint",
            isGenerated: true,
            generationStrategy: "identity",
            generatedIdentity: "ALWAYS",
          },
          { name: "owner_id", type: "text" },
          { name: "kind", type: "text" },
          { name: "agent_id", type: "uuid", isNullable: true },
          { name: "message_id", type: "uuid", isNullable: true },
          { name: "summary", type: "text", isNullable: true },
          { name: "summary_status", type: "text", default: "'pending'" },
          { name: "summary_started_at", type: "timestamptz", isNullable: true },
          { name: "read_at", type: "timestamptz", isNullable: true },
          { name: "created_at", type: "timestamptz", default: "now()" },
        ],
        uniques: [
          { name: "updates_sequence_key", columnNames: ["sequence"] },
          { name: "updates_message_id_key", columnNames: ["message_id"] },
        ],
        indices: [
          new TableIndex({
            name: "updates_unread",
            columnNames: ["owner_id", "sequence"],
            where: "read_at IS NULL",
          }),
          new TableIndex({
            name: "updates_pending_summary",
            columnNames: ["created_at", "sequence"],
            where: "read_at IS NULL AND summary_status = 'pending'",
          }),
          new TableIndex({ name: "updates_agent", columnNames: ["agent_id"] }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: "updates_agent_id_fkey",
            columnNames: ["agent_id"],
            referencedTableName: "agents",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          }),
          new TableForeignKey({
            name: "updates_message_id_fkey",
            columnNames: ["message_id"],
            referencedTableName: "messages",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          }),
        ],
        checks: [
          new TableCheck({
            name: "updates_kind_check",
            expression: "kind IN ('message')",
          }),
          new TableCheck({
            name: "updates_message_reference_check",
            expression:
              "kind <> 'message' OR (agent_id IS NOT NULL AND message_id IS NOT NULL)",
          }),
          new TableCheck({
            name: "updates_summary_check",
            expression: "summary IS NULL OR length(summary) BETWEEN 1 AND 200",
          }),
          new TableCheck({
            name: "updates_summary_status_check",
            expression:
              "summary_status IN ('pending', 'generating', 'ready', 'failed')",
          }),
        ],
      }),
    );
  }

  /** Remove updates without changing the conversations they pointed to. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("updates");
  }
}
