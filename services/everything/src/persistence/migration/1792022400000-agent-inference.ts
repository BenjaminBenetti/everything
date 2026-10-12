import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from "typeorm";

/** Preserve existing teammates while adding their explicit inference selection. */
export class AgentInference1792022400000 implements MigrationInterface {
  /** Existing teammates remain unassigned until their owner selects a provider. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.addColumn(
      "agents",
      new TableColumn({
        name: "inference",
        type: "jsonb",
        isNullable: true,
      }),
    );
  }

  /** Remove only the selection when rolling back. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropColumn("agents", "inference");
  }
}
