import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/** Store teammate passes: short-lived, hashed credentials that open one artifact on the artifact host. */
export class ViewPasses1792108800000 implements MigrationInterface {
  /** Create the passes table; a pass is deleted with its artifact. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "view_passes",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "owner_id", type: "text" },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "artifact_id", type: "uuid" },
          { name: "token_hash", type: "text", isUnique: true },
          { name: "path", type: "text" },
          { name: "expires_at", type: "timestamptz" },
        ],
        foreignKeys: [
          {
            columnNames: ["artifact_id"],
            referencedTableName: "artifacts",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
      }),
    );
  }

  /** Remove the passes table on an explicit rollback. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("view_passes");
  }
}
