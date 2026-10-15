import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/** Persist general preferences while keeping existing owners on the enabled default. */
export class GeneralSettings1792368000000 implements MigrationInterface {
  /** Create an owner-scoped settings record only when preferences are first saved. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "general_settings",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "owner_id", type: "text" },
          { name: "summarize_updates", type: "boolean", default: true },
        ],
        uniques: [
          { name: "general_settings_owner_key", columnNames: ["owner_id"] },
        ],
      }),
    );
  }

  /** Remove preferences only when explicitly rolling back this migration. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("general_settings");
  }
}
