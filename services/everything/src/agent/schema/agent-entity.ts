import { EntitySchema } from "typeorm";
import {
  baseColumns,
  timestampTransformer,
} from "@everything/persistence/schema";
import {
  agentAvatarIds,
  defaultAgentAvatarId,
} from "@everything/agent-contracts/avatar";
import { agentLimits } from "../model/agent.js";
import type { AgentRecord } from "../model/agent-record.js";

/** Map definitions to the existing table without changing stored records. */
export const AgentEntity = new EntitySchema<AgentRecord>({
  name: "AgentDefinition",
  tableName: "agents",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    name: { type: "text" },
    systemPrompt: { name: "system_prompt", type: "text" },
    inference: { type: "jsonb", nullable: true },
    lastInteractedAt: {
      name: "last_interacted_at",
      type: "timestamptz",
      nullable: true,
      transformer: timestampTransformer,
    },
    avatarId: {
      name: "avatar_id",
      type: "text",
      default: defaultAgentAvatarId,
    },
  },
  indices: [
    { name: "agents_owner", columns: ["ownerId"] },
    {
      name: "agents_recent",
      columns: ["ownerId", "lastInteractedAt", "id"],
      where: "last_interacted_at IS NOT NULL",
    },
  ],
  checks: [
    {
      name: "agents_name_check",
      expression: `length(name) BETWEEN 1 AND ${agentLimits.nameLength}`,
    },
    {
      name: "agents_system_prompt_check",
      expression: `length(system_prompt) BETWEEN 1 AND ${agentLimits.systemPromptLength}`,
    },
    {
      name: "agents_avatar_id_check",
      expression: `avatar_id IN (${agentAvatarIds.map((id) => `'${id}'`).join(", ")})`,
    },
  ],
});
