import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/** Store provider credentials independently of teammate definitions and runtime sessions. */
export class ProviderConnections1791936000000 implements MigrationInterface {
  /** Create one encrypted connection per provider and authenticated owner. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "provider_connections",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "owner_id", type: "text" },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "provider", type: "text" },
          { name: "configured", type: "boolean" },
          { name: "base_url", type: "text", isNullable: true },
          { name: "model", type: "text", isNullable: true },
          { name: "account", type: "text", isNullable: true },
          { name: "encrypted_credential", type: "text" },
          { name: "encrypted_pending", type: "text", isNullable: true },
          { name: "verified_at", type: "timestamptz", isNullable: true },
          { name: "verification_error", type: "text", isNullable: true },
        ],
        uniques: [
          {
            name: "provider_connections_owner_provider",
            columnNames: ["owner_id", "provider"],
          },
        ],
        checks: [
          {
            name: "provider_connections_provider_check",
            expression:
              "provider IN ('chatgpt', 'anthropic', 'openai-compatible')",
          },
        ],
      }),
    );
  }

  /** Remove only the connection records on an explicit migration rollback. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("provider_connections");
  }
}
