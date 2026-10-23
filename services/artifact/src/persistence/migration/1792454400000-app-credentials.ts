import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/**
 * Store which credentials each dynamic app receives, by credential ID and version, and a durable
 * record of every credential's newest delivered version and revocation. Values are never stored
 * here; existing apps start with no credentials.
 */
export class AppCredentials1792454400000 implements MigrationInterface {
  /** Create grants removed with their app, and records that outlive every grant. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "app_credential_bindings",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "owner_id", type: "text" },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "artifact_id", type: "uuid" },
          { name: "credential_id", type: "uuid" },
          { name: "env", type: "text" },
          { name: "version", type: "integer" },
        ],
        uniques: [
          {
            name: "app_credential_bindings_env",
            columnNames: ["artifact_id", "env"],
          },
        ],
        indices: [
          {
            name: "app_credential_bindings_credential",
            columnNames: ["credential_id"],
          },
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
            name: "app_credential_bindings_env_check",
            expression: "env ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'",
          },
          {
            name: "app_credential_bindings_version_check",
            expression: "version >= 1",
          },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "credential_records",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "version", type: "integer" },
          { name: "revoked_at", type: "timestamptz", isNullable: true },
        ],
        checks: [
          {
            name: "credential_records_version_check",
            expression: "version >= 1",
          },
        ],
      }),
    );
  }

  /** Remove grants and records on an explicit rollback; apps stop receiving credentials. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("credential_records");
    await runner.dropTable("app_credential_bindings");
  }
}
