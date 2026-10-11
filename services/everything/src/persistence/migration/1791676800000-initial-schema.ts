import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/**
 * Create the application schema. Names and limits are deliberately literal: a migration records the
 * schema at one point in time, so later changes to entity constants require a new migration.
 */
export class InitialSchema1791676800000 implements MigrationInterface {
  /** Create the agents and messages tables. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "agents",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            primaryKeyConstraintName: "agents_pkey",
          },
          { name: "owner_id", type: "text" },
          { name: "name", type: "text" },
          { name: "system_prompt", type: "text" },
          { name: "created_at", type: "timestamptz", default: "now()" },
        ],
        indices: [{ name: "agents_owner", columnNames: ["owner_id"] }],
        checks: [
          {
            name: "agents_name_check",
            expression: "length(name) BETWEEN 1 AND 80",
          },
          {
            name: "agents_system_prompt_check",
            expression: "length(system_prompt) BETWEEN 1 AND 16000",
          },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "messages",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            primaryKeyConstraintName: "messages_pkey",
          },
          {
            name: "sequence",
            type: "bigint",
            isGenerated: true,
            generationStrategy: "identity",
            generatedIdentity: "ALWAYS",
          },
          { name: "agent_id", type: "uuid" },
          { name: "role", type: "text" },
          { name: "text", type: "text" },
          { name: "created_at", type: "timestamptz", default: "now()" },
        ],
        uniques: [{ name: "messages_sequence_key", columnNames: ["sequence"] }],
        indices: [
          {
            name: "messages_agent_sequence",
            columnNames: ["agent_id", "sequence"],
          },
        ],
        foreignKeys: [
          {
            name: "messages_agent_id_fkey",
            columnNames: ["agent_id"],
            referencedTableName: "agents",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
        checks: [
          {
            name: "messages_role_check",
            expression: "role IN ('user', 'assistant')",
          },
          {
            name: "messages_text_check",
            expression: "length(text) BETWEEN 1 AND 32000",
          },
        ],
      }),
    );
  }

  /** Drop the application schema. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable("messages");
    await runner.dropTable("agents");
  }
}
