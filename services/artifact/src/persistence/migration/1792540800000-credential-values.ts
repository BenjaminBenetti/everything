import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/**
 * Identify each credential value with Everything's random value ID, so one version is never
 * accepted with two values, and count each app's grant changes, so a grant authorized before a
 * removal can't be committed after it. Existing grants and records keep no identity until their
 * next delivery; existing apps start at generation 0.
 */
export class CredentialValues1792540800000 implements MigrationInterface {
  /** Add value identities and per-app generations. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      "ALTER TABLE credential_records ADD COLUMN value_id uuid NULL",
    );
    await runner.query(
      "ALTER TABLE app_credential_bindings ADD COLUMN value_id uuid NULL",
    );
    await runner.createTable(
      new Table({
        name: "app_credential_generations",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "generation", type: "integer" },
        ],
        foreignKeys: [
          {
            columnNames: ["id"],
            referencedTableName: "artifacts",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
        checks: [
          {
            name: "app_credential_generations_generation_check",
            expression: "generation >= 0",
          },
        ],
      }),
    );
  }

  /** Remove identities and generations on an explicit rollback. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("app_credential_generations");
    await runner.query(
      "ALTER TABLE app_credential_bindings DROP COLUMN value_id",
    );
    await runner.query("ALTER TABLE credential_records DROP COLUMN value_id");
  }
}
