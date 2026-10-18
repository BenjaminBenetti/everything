import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/** Store a verification hash of each dynamic app's API key; keys themselves are never stored here. */
export class AppApiKeys1792368000000 implements MigrationInterface {
  /** Create one record per app, deleted with its app. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "app_api_keys",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "owner_id", type: "text" },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "artifact_id", type: "uuid", isUnique: true },
          { name: "key_hash", type: "text" },
        ],
        foreignKeys: [
          {
            columnNames: ["artifact_id"],
            referencedTableName: "artifacts",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
        checks: [
          {
            name: "app_api_keys_hash_check",
            expression: "key_hash ~ '^[0-9a-f]{64}$'",
          },
        ],
      }),
    );
  }

  /** Remove the records on an explicit rollback; every key stops working. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("app_api_keys");
  }
}
