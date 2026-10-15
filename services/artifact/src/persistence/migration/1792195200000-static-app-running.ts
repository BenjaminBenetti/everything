import type { MigrationInterface, QueryRunner } from "typeorm";

/** Keep already published pages live when static apps gain pause and resume. */
export class StaticAppRunning1792195200000 implements MigrationInterface {
  /** Backfill the running flag that older versions only consulted for dynamic apps. */
  async up(query: QueryRunner): Promise<void> {
    await query.query(
      "UPDATE artifacts SET running = true WHERE kind = 'static' AND live_revision IS NOT NULL",
    );
  }

  /** Restore the unused static flag expected by earlier versions. */
  async down(query: QueryRunner): Promise<void> {
    await query.query(
      "UPDATE artifacts SET running = false WHERE kind = 'static'",
    );
  }
}
