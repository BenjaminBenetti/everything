import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import type { WorkspaceInteractionRecord } from "../model/workspace-interaction.js";

/** Keep activity attached to the owning teammate and remove it when that teammate is deleted. */
export const WorkspaceInteractionEntity =
  new EntitySchema<WorkspaceInteractionRecord>({
    name: "WorkspaceInteractionRecord",
    tableName: "workspace_interactions",
    columns: {
      ...baseColumns,
      agentId: { name: "agent_id", type: "uuid" },
      type: { name: "workspace_type", type: "text" },
      name: { name: "workspace_name", type: "text" },
      lastInteractedAt: {
        name: "last_interacted_at",
        type: "timestamptz",
        transformer: timestampTransformer,
      },
    },
    relations: {
      agent: {
        type: "many-to-one",
        target: "AgentDefinition",
        nullable: false,
        onDelete: "CASCADE",
        joinColumn: {
          name: "agent_id",
          referencedColumnName: "id",
          foreignKeyConstraintName: "workspace_interactions_agent_id_fkey",
        },
      },
    },
    uniques: [
      {
        name: "workspace_interactions_identity",
        columns: ["agentId", "type", "name"],
      },
    ],
    indices: [
      {
        name: "workspace_interactions_recent",
        columns: ["agentId", "lastInteractedAt"],
      },
    ],
  });
