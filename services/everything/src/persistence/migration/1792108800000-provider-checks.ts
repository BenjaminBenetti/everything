import {
  TableColumn,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from "typeorm";

/** Retain the daily check schedule across restarts, including unsuccessful attempts. */
export class ProviderChecks1792108800000 implements MigrationInterface {
  /** Preserve existing successful checks as the first persisted scheduling timestamp. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.addColumn(
      "provider_connections",
      new TableColumn({
        name: "last_checked_at",
        type: "timestamptz",
        isNullable: true,
      }),
    );
    await runner.query(
      'UPDATE "provider_connections" SET "last_checked_at" = "verified_at"',
    );
    await runner.createIndex(
      "provider_connections",
      new TableIndex({
        name: "provider_connections_due_check",
        columnNames: ["configured", "last_checked_at"],
      }),
    );
  }

  /** Remove only the scheduling metadata on an explicit rollback. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropIndex(
      "provider_connections",
      "provider_connections_due_check",
    );
    await runner.dropColumn("provider_connections", "last_checked_at");
  }
}
