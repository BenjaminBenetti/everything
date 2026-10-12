import { EntitySchema } from "typeorm";
import { baseColumns } from "@everything/persistence/schema";
import type { DeploymentRecord } from "../model/deployment.js";

/** Map deployments to the `artifact_deployments` table; rows are removed with their artifact. */
export const DeploymentEntity = new EntitySchema<DeploymentRecord>({
  name: "Deployment",
  tableName: "artifact_deployments",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    artifactId: { name: "artifact_id", type: "uuid" },
    release: { type: "integer" },
    authorId: { name: "author_id", type: "text" },
    authorName: { name: "author_name", type: "text" },
    build: { type: "integer" },
    imageDigest: { name: "image_digest", type: "text" },
    port: { type: "integer" },
    env: { type: "jsonb" },
    database: { type: "boolean" },
    diskGi: { name: "disk_gi", type: "integer", nullable: true },
    healthPath: { name: "health_path", type: "text", nullable: true },
  },
  uniques: [
    {
      name: "artifact_deployments_release",
      columns: ["artifactId", "release"],
    },
  ],
});
