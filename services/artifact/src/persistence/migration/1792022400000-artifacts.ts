import { Table, type MigrationInterface, type QueryRunner } from "typeorm";

/** Columns shared by every artifact table, written out because migrations record a point in time. */
const identity = [
  { name: "id", type: "uuid", isPrimary: true },
  { name: "owner_id", type: "text" },
  { name: "created_at", type: "timestamptz", default: "now()" },
];

/** A column referencing the artifact a row belongs to; rows are deleted with their artifact. */
const artifactReference = {
  columnNames: ["artifact_id"],
  referencedTableName: "artifacts",
  referencedColumnNames: ["id"],
  onDelete: "CASCADE",
};

/**
 * Create the artifact service's schema. Names and limits are deliberately literal: a migration records
 * the schema at one point in time, so later changes to entity constants require a new migration.
 */
export class Artifacts1792022400000 implements MigrationInterface {
  /** Create artifacts, their revisions, builds, and deployments, and artifact host credentials. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "artifacts",
        columns: [
          ...identity,
          { name: "updated_at", type: "timestamptz", default: "now()" },
          { name: "slug", type: "text", isUnique: true },
          { name: "kind", type: "text" },
          { name: "title", type: "text" },
          { name: "description", type: "text" },
          { name: "created_by_id", type: "text" },
          { name: "created_by_name", type: "text" },
          { name: "updated_by_id", type: "text" },
          { name: "updated_by_name", type: "text" },
          { name: "release", type: "integer", default: 0 },
          { name: "live_revision", type: "integer", isNullable: true },
          { name: "live_deployment", type: "integer", isNullable: true },
          { name: "running", type: "boolean", default: false },
          { name: "disk_gi", type: "integer", isNullable: true },
        ],
        indices: [{ name: "artifacts_owner", columnNames: ["owner_id"] }],
        checks: [
          {
            name: "artifacts_kind_check",
            expression: "kind IN ('static', 'dynamic')",
          },
          {
            name: "artifacts_slug_check",
            expression: "slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'",
          },
          {
            name: "artifacts_title_check",
            expression: "length(title) BETWEEN 1 AND 120",
          },
          {
            name: "artifacts_description_check",
            expression: "length(description) <= 2000",
          },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "artifact_revisions",
        columns: [
          ...identity,
          { name: "artifact_id", type: "uuid" },
          { name: "number", type: "integer" },
          { name: "author_id", type: "text" },
          { name: "author_name", type: "text" },
          { name: "files", type: "jsonb" },
          { name: "file_count", type: "integer" },
          { name: "total_size", type: "integer" },
        ],
        uniques: [
          {
            name: "artifact_revisions_number",
            columnNames: ["artifact_id", "number"],
          },
        ],
        foreignKeys: [
          { name: "artifact_revisions_artifact", ...artifactReference },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "artifact_builds",
        columns: [
          ...identity,
          { name: "artifact_id", type: "uuid" },
          { name: "number", type: "integer" },
          { name: "author_id", type: "text" },
          { name: "author_name", type: "text" },
          { name: "status", type: "text" },
          { name: "dockerfile", type: "text" },
          { name: "build_args", type: "jsonb" },
          { name: "files", type: "jsonb" },
          { name: "file_count", type: "integer" },
          { name: "total_size", type: "integer" },
          { name: "image_digest", type: "text", isNullable: true },
          { name: "log", type: "text", isNullable: true },
          { name: "error", type: "text", isNullable: true },
          { name: "source_token_hash", type: "text" },
          { name: "finished_at", type: "timestamptz", isNullable: true },
        ],
        uniques: [
          {
            name: "artifact_builds_number",
            columnNames: ["artifact_id", "number"],
          },
        ],
        indices: [{ name: "artifact_builds_status", columnNames: ["status"] }],
        checks: [
          {
            name: "artifact_builds_status_check",
            expression:
              "status IN ('queued', 'running', 'succeeded', 'failed')",
          },
        ],
        foreignKeys: [
          { name: "artifact_builds_artifact", ...artifactReference },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "artifact_deployments",
        columns: [
          ...identity,
          { name: "artifact_id", type: "uuid" },
          { name: "release", type: "integer" },
          { name: "author_id", type: "text" },
          { name: "author_name", type: "text" },
          { name: "build", type: "integer" },
          { name: "image_digest", type: "text" },
          { name: "port", type: "integer" },
          { name: "env", type: "jsonb" },
          { name: "database", type: "boolean" },
          { name: "disk_gi", type: "integer", isNullable: true },
          { name: "health_path", type: "text", isNullable: true },
        ],
        uniques: [
          {
            name: "artifact_deployments_release",
            columnNames: ["artifact_id", "release"],
          },
        ],
        foreignKeys: [
          { name: "artifact_deployments_artifact", ...artifactReference },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "view_grants",
        columns: [
          ...identity,
          { name: "token_hash", type: "text", isUnique: true },
          { name: "next", type: "text" },
          { name: "expires_at", type: "timestamptz" },
          { name: "used_at", type: "timestamptz", isNullable: true },
        ],
      }),
    );
    await runner.createTable(
      new Table({
        name: "view_sessions",
        columns: [
          ...identity,
          { name: "token_hash", type: "text", isUnique: true },
          { name: "expires_at", type: "timestamptz" },
        ],
      }),
    );
  }

  /** Remove the artifact service's tables on an explicit rollback. */
  async down(runner: QueryRunner): Promise<void> {
    for (const table of [
      "view_sessions",
      "view_grants",
      "artifact_deployments",
      "artifact_builds",
      "artifact_revisions",
      "artifacts",
    ])
      await runner.dropTable(table);
  }
}
