import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Add generic credentials to the key store: a description, a version that increases with each new
 * value, the time the value was saved, and a deletion marker kept while apps are told to remove a
 * deleted credential. Existing SSH keys keep their rows and start at version 1.
 */
export class GenericCredentials1792886400000 implements MigrationInterface {
  /** Add the columns, backfill save times, and constrain names and deletion markers. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      "ALTER TABLE keys ADD COLUMN description varchar(500) NULL",
    );
    await runner.query(
      "ALTER TABLE keys ADD COLUMN version integer NOT NULL DEFAULT 1 CONSTRAINT keys_version_check CHECK (version >= 1)",
    );
    await runner.query("ALTER TABLE keys ADD COLUMN updated_at timestamptz");
    await runner.query("UPDATE keys SET updated_at = created_at");
    await runner.query(
      "ALTER TABLE keys ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now()",
    );
    await runner.query("ALTER TABLE keys ADD COLUMN deleted_at timestamptz");
    // Only generic credentials are kept after deletion, and only with their value erased.
    await runner.query(
      "ALTER TABLE keys ADD CONSTRAINT keys_deleted_check CHECK (deleted_at IS NULL OR (type = 'generic' AND encrypted_material = ''))",
    );
    // Teammates choose credentials by name, so live names can't differ only by case.
    await runner.query(
      "CREATE UNIQUE INDEX keys_generic_name ON keys (lower(name)) WHERE type = 'generic' AND deleted_at IS NULL",
    );
  }

  /**
   * Refuse to roll back while generic credentials exist: older versions would show deleted ones as
   * usable keys and couldn't remove them from apps. Delete them, and let removal finish, first.
   */
  async down(runner: QueryRunner): Promise<void> {
    const [row] = (await runner.query(
      "SELECT count(*)::int AS count FROM keys WHERE type <> 'ssh'",
    )) as { count: number }[];
    if (row && row.count > 0)
      throw new Error(
        "Delete every generic credential, and wait for apps to stop using them, before rolling back",
      );
    await runner.query("DROP INDEX keys_generic_name");
    await runner.query(
      "ALTER TABLE keys DROP CONSTRAINT keys_deleted_check, DROP COLUMN deleted_at, DROP COLUMN updated_at, DROP COLUMN version, DROP COLUMN description",
    );
  }
}
