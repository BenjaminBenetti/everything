import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from "typeorm";

/** Keep each owner's teammate order with their other general preferences. */
export class GeneralSettingsTeammateOrder1792800000000 implements MigrationInterface {
  /** Existing owners keep creation order until they rearrange their team. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.addColumn(
      "general_settings",
      new TableColumn({
        name: "teammate_order",
        type: "jsonb",
        default: "'[]'",
      }),
    );
  }

  /** Remove only the order when rolling back. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropColumn("general_settings", "teammate_order");
  }
}
