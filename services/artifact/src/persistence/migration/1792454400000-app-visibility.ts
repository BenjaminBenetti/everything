import type { MigrationInterface, QueryRunner } from "typeorm";

/** Every existing app stays private when apps gain public links; only owners make them public. */
export class AppVisibility1792454400000 implements MigrationInterface {
  /** Add who can open each app, private for every existing and new row unless set otherwise. */
  async up(query: QueryRunner): Promise<void> {
    await query.query(
      "ALTER TABLE artifacts ADD COLUMN visibility text NOT NULL DEFAULT 'private'",
    );
    await query.query(
      "ALTER TABLE artifacts ADD CONSTRAINT artifacts_visibility_check CHECK (visibility IN ('private', 'public'))",
    );
  }

  /** Remove public links on an explicit rollback; every app is then private again. */
  async down(query: QueryRunner): Promise<void> {
    await query.query(
      "ALTER TABLE artifacts DROP CONSTRAINT artifacts_visibility_check",
    );
    await query.query("ALTER TABLE artifacts DROP COLUMN visibility");
  }
}
