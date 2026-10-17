import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/** Store extensible, owner-scoped key records with encrypted material. */
export class Keys1792713600000 implements MigrationInterface {
  /** Create searchable metadata without restricting future key types to a database enum. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "keys",
        columns: [
          { name: "id", type: "uuid", isPrimary: true },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "owner_id", type: "text" },
          { name: "name", type: "varchar", length: "128" },
          { name: "type", type: "varchar", length: "64" },
          { name: "encrypted_material", type: "text" },
        ],
        indices: [
          {
            name: "keys_owner_created",
            columnNames: ["owner_id", "created_at", "id"],
          },
        ],
      }),
    );
  }

  /** Remove the table only during an explicit rollback. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("keys");
  }
}
