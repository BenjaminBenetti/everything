import {
  TableCheck,
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from "typeorm";

/** Persist a stable avatar choice and give existing definitions the first avatar. */
export class AgentAvatars1791849600000 implements MigrationInterface {
  /** Add the non-null column with a default that backfills every existing row. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.addColumn(
      "agents",
      new TableColumn({
        name: "avatar_id",
        type: "text",
        default: "'avatar-01'",
        isNullable: false,
      }),
    );
    await runner.createCheckConstraint(
      "agents",
      new TableCheck({
        name: "agents_avatar_id_check",
        expression:
          "avatar_id IN ('avatar-01', 'avatar-02', 'avatar-03', 'avatar-04', 'avatar-05', 'avatar-06', 'avatar-07', 'avatar-08', 'avatar-09', 'avatar-10', 'avatar-11', 'avatar-12', 'avatar-13', 'avatar-14', 'avatar-15', 'avatar-16', 'avatar-17', 'avatar-18', 'avatar-19', 'avatar-20', 'avatar-21', 'avatar-22', 'avatar-23', 'avatar-24', 'avatar-25', 'avatar-26', 'avatar-27', 'avatar-28', 'avatar-29', 'avatar-30', 'avatar-31', 'avatar-32', 'avatar-33', 'avatar-34', 'avatar-35', 'avatar-36', 'avatar-37', 'avatar-38', 'avatar-39', 'avatar-40', 'avatar-41', 'avatar-42', 'avatar-43', 'avatar-44', 'avatar-45', 'avatar-46', 'avatar-47', 'avatar-48', 'avatar-49', 'avatar-50', 'avatar-51', 'avatar-52', 'avatar-53', 'avatar-54', 'avatar-55', 'avatar-56', 'avatar-57', 'avatar-58', 'avatar-59', 'avatar-60', 'avatar-61', 'avatar-62', 'avatar-63', 'avatar-64')",
      }),
    );
  }

  /** Remove only avatar selection when rolling back the profile change. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.dropCheckConstraint("agents", "agents_avatar_id_check");
    await runner.dropColumn("agents", "avatar_id");
  }
}
