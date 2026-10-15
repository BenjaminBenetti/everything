import {
  TableColumn,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from "typeorm";

/** Remember explicit teammate interactions, seeding existing history from sent user messages. */
export class AgentInteractions1792540800000 implements MigrationInterface {
  /** Add recency metadata and backfill only user messages, excluding background replies. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.addColumn(
      "agents",
      new TableColumn({
        name: "last_interacted_at",
        type: "timestamptz",
        isNullable: true,
      }),
    );
    await runner.query(`
      UPDATE agents SET last_interacted_at = activity.latest
      FROM (SELECT agent_id, MAX(created_at) AS latest FROM messages WHERE role = 'user' GROUP BY agent_id) AS activity
      WHERE agents.id = activity.agent_id
    `);
    await runner.createIndex(
      "agents",
      new TableIndex({
        name: "agents_recent",
        columnNames: ["owner_id", "last_interacted_at", "id"],
        where: "last_interacted_at IS NOT NULL",
      }),
    );
  }

  /** Remove recency metadata without changing teammate definitions or message history. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropIndex("agents", "agents_recent");
    await runner.dropColumn("agents", "last_interacted_at");
  }
}
