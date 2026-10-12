import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import type { BuildRecord } from "../model/build.js";

/** Map builds to the `artifact_builds` table; rows are removed with their artifact. */
export const BuildEntity = new EntitySchema<BuildRecord>({
  name: "Build",
  tableName: "artifact_builds",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    artifactId: { name: "artifact_id", type: "uuid" },
    number: { type: "integer" },
    authorId: { name: "author_id", type: "text" },
    authorName: { name: "author_name", type: "text" },
    status: { type: "text" },
    dockerfile: { type: "text" },
    buildArgs: { name: "build_args", type: "jsonb" },
    files: { type: "jsonb" },
    fileCount: { name: "file_count", type: "integer" },
    totalSize: { name: "total_size", type: "integer" },
    imageDigest: { name: "image_digest", type: "text", nullable: true },
    log: { type: "text", nullable: true },
    error: { type: "text", nullable: true },
    sourceTokenHash: { name: "source_token_hash", type: "text" },
    finishedAt: {
      name: "finished_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
  },
  uniques: [
    { name: "artifact_builds_number", columns: ["artifactId", "number"] },
  ],
  indices: [{ name: "artifact_builds_status", columns: ["status"] }],
  checks: [
    {
      name: "artifact_builds_status_check",
      expression: "status IN ('queued', 'running', 'succeeded', 'failed')",
    },
  ],
});
