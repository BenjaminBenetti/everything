import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Give each saved generic credential value a random identity, regenerated whenever the value is
 * replaced, so apps can tell a value from a different one saved under the same version, for
 * example after a database restore. The identity is random, never derived from the value.
 */
export class CredentialValueIds1792972800000 implements MigrationInterface {
  /** Add the identity and give existing generic credentials one. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("ALTER TABLE keys ADD COLUMN value_id uuid NULL");
    await runner.query(
      "UPDATE keys SET value_id = gen_random_uuid() WHERE type = 'generic'",
    );
    await runner.query(
      "ALTER TABLE keys ADD CONSTRAINT keys_value_id_check CHECK (type <> 'generic' OR value_id IS NOT NULL)",
    );
  }

  /** Remove the identity on an explicit rollback. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      "ALTER TABLE keys DROP CONSTRAINT keys_value_id_check, DROP COLUMN value_id",
    );
  }
}
