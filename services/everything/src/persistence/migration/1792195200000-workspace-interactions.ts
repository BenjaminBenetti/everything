import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/** Retain workspace recency for each saved teammate across runtime and application restarts. */
export class WorkspaceInteractions1792195200000 implements MigrationInterface {
  /** Create one unique workspace interaction record per teammate, with cascading deletion. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "workspace_interactions",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "agent_id", type: "uuid" },
          { name: "workspace_type", type: "text" },
          { name: "workspace_name", type: "text" },
          { name: "last_interacted_at", type: "timestamptz" },
        ],
        uniques: [
          {
            name: "workspace_interactions_identity",
            columnNames: ["agent_id", "workspace_type", "workspace_name"],
          },
        ],
        indices: [
          {
            name: "workspace_interactions_recent",
            columnNames: ["agent_id", "last_interacted_at"],
          },
        ],
        foreignKeys: [
          {
            name: "workspace_interactions_agent_id_fkey",
            columnNames: ["agent_id"],
            referencedTableName: "agents",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
      }),
    );
  }

  /** Remove activity metadata only when explicitly rolling back this migration. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("workspace_interactions");
  }
}
