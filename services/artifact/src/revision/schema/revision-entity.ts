import { EntitySchema } from "typeorm";
import { baseColumns } from "@everything/persistence/schema";
import type { RevisionRecord } from "../model/revision.js";

/** Map revisions to the `artifact_revisions` table; rows are removed with their artifact. */
export const RevisionEntity = new EntitySchema<RevisionRecord>({
  name: "Revision",
  tableName: "artifact_revisions",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    artifactId: { name: "artifact_id", type: "uuid" },
    number: { type: "integer" },
    authorId: { name: "author_id", type: "text" },
    authorName: { name: "author_name", type: "text" },
    files: { type: "jsonb" },
    fileCount: { name: "file_count", type: "integer" },
    totalSize: { name: "total_size", type: "integer" },
  },
  uniques: [
    { name: "artifact_revisions_number", columns: ["artifactId", "number"] },
  ],
});
