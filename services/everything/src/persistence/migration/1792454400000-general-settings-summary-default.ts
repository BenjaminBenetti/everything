import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from "typeorm";

/** Default new settings records to previews while preserving saved preferences. */
export class GeneralSettingsSummaryDefault1792454400000 implements MigrationInterface {
  /** Require explicit opt-in for new settings records. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.changeColumn(
      "general_settings",
      "summarize_updates",
      new TableColumn({
        name: "summarize_updates",
        type: "boolean",
        default: false,
      }),
    );
  }

  /** Restore the earlier database default without changing saved preferences. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.changeColumn(
      "general_settings",
      "summarize_updates",
      new TableColumn({
        name: "summarize_updates",
        type: "boolean",
        default: true,
      }),
    );
  }
}
