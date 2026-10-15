import { TableIndex, type MigrationInterface, type QueryRunner } from "typeorm";

/** Keep owner-scoped history pagination efficient as seen updates accumulate. */
export class UpdateHistory1792627200000 implements MigrationInterface {
  /** Index seen updates in the same stable insertion order used by unread updates. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createIndex(
      "updates",
      new TableIndex({
        name: "updates_seen",
        columnNames: ["owner_id", "sequence"],
        where: "read_at IS NOT NULL",
      }),
    );
  }

  /** Remove only the history index, retaining all messages and receipts. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropIndex("updates", "updates_seen");
  }
}
