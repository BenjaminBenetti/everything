import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import { artifactLimits } from "@everything/artifact-contracts";
import type { ArtifactRecord } from "../model/artifact.js";

/** Map artifact records to the `artifacts` table. */
export const ArtifactEntity = new EntitySchema<ArtifactRecord>({
  name: "Artifact",
  tableName: "artifacts",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    updatedAt: {
      name: "updated_at",
      type: "timestamptz",
      transformer: timestampTransformer,
    },
    slug: { type: "text", unique: true },
    kind: { type: "text" },
    title: { type: "text" },
    description: { type: "text" },
    createdById: { name: "created_by_id", type: "text" },
    createdByName: { name: "created_by_name", type: "text" },
    updatedById: { name: "updated_by_id", type: "text" },
    updatedByName: { name: "updated_by_name", type: "text" },
    release: { type: "integer" },
    liveRevision: { name: "live_revision", type: "integer", nullable: true },
    liveDeployment: {
      name: "live_deployment",
      type: "integer",
      nullable: true,
    },
    running: { type: "boolean" },
    diskGi: { name: "disk_gi", type: "integer", nullable: true },
    visibility: { type: "text", default: "private" },
  },
  indices: [{ name: "artifacts_owner", columns: ["ownerId"] }],
  checks: [
    {
      name: "artifacts_kind_check",
      expression: "kind IN ('static', 'dynamic')",
    },
    {
      name: "artifacts_title_check",
      expression: `length(title) BETWEEN 1 AND ${artifactLimits.titleLength}`,
    },
    {
      name: "artifacts_description_check",
      expression: `length(description) <= ${artifactLimits.descriptionLength}`,
    },
    {
      name: "artifacts_visibility_check",
      expression: "visibility IN ('private', 'public')",
    },
  ],
});
