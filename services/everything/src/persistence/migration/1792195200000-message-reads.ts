import {
  TableColumn,
  TableCheck,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from "typeorm";

/** Start durable receipts at rollout; earlier messages have no reliable visibility history. */
export class MessageReads1792195200000 implements MigrationInterface {
  /** Baseline existing history as read, leaving future messages unread by default. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.addColumn(
      "messages",
      new TableColumn({
        name: "read_at",
        type: "timestamptz",
        isNullable: true,
      }),
    );
    await runner.query('UPDATE "messages" SET "read_at" = CURRENT_TIMESTAMP');
    await runner.addColumns("messages", [
      new TableColumn({
        name: "update_summary",
        type: "text",
        isNullable: true,
      }),
      new TableColumn({
        name: "summary_status",
        type: "text",
        default: "'pending'",
      }),
      new TableColumn({
        name: "summary_started_at",
        type: "timestamptz",
        isNullable: true,
      }),
    ]);
    await runner.createCheckConstraints("messages", [
      new TableCheck({
        name: "messages_summary_status_check",
        expression:
          "summary_status IN ('pending', 'generating', 'ready', 'failed')",
      }),
      new TableCheck({
        name: "messages_update_summary_check",
        expression:
          "update_summary IS NULL OR length(update_summary) BETWEEN 1 AND 280",
      }),
    ]);
    await runner.createIndex(
      "messages",
      new TableIndex({
        name: "messages_pending_summary",
        columnNames: ["created_at", "sequence"],
        where:
          "role = 'assistant' AND read_at IS NULL AND summary_status = 'pending'",
      }),
    );
    await runner.createIndex(
      "messages",
      new TableIndex({
        name: "messages_unread",
        columnNames: ["agent_id", "sequence"],
        where: "role = 'assistant' AND read_at IS NULL",
      }),
    );
  }

  /** Remove receipt metadata without removing conversation content. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropIndex("messages", "messages_unread");
    await runner.dropIndex("messages", "messages_pending_summary");
    await runner.dropCheckConstraint(
      "messages",
      "messages_summary_status_check",
    );
    await runner.dropCheckConstraint(
      "messages",
      "messages_update_summary_check",
    );
    await runner.dropColumns("messages", [
      "update_summary",
      "summary_status",
      "summary_started_at",
      "read_at",
    ]);
  }
}
