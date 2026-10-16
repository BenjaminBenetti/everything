import type { MigrationInterface, QueryRunner } from "typeorm";

/** Existing deployments retain no API access when capabilities are introduced. */
export class AppCapabilities1792281600000 implements MigrationInterface {
  /** Store requested capabilities without storing their generated credentials. */
  async up(query: QueryRunner): Promise<void> {
    await query.query(
      "ALTER TABLE artifact_deployments ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]'::jsonb",
    );
  }

  /** Remove capability settings when rolling back the schema. */
  async down(query: QueryRunner): Promise<void> {
    await query.query(
      "ALTER TABLE artifact_deployments DROP COLUMN capabilities",
    );
  }
}
