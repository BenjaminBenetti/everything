import {
  TableColumn,
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
    await runner.dropColumn("messages", "read_at");
  }
}
