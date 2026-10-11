import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/** Add durable browser capabilities and encrypted Keycloak credentials. */
export class BrowserSessions1791763200000 implements MigrationInterface {
  /** Create a separate session table without changing agents or conversations. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "browser_sessions",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "owner_id", type: "text" },
          { name: "token_hash", type: "text" },
          { name: "encrypted_grant", type: "text" },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "expires_at", type: "timestamptz" },
        ],
        indices: [
          {
            name: "browser_sessions_owner_expiry",
            columnNames: ["owner_id", "expires_at"],
          },
        ],
      }),
    );
  }
  /** Remove only browser sessions when rolling back this migration. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("browser_sessions");
  }
}
