import { EntitySchema } from "typeorm";
import { baseColumns } from "@everything/persistence/schema";
import { agentLimits, type AgentDefinition } from "../model/agent.js";

/** Map definitions to the existing table without changing stored records. */
export const AgentEntity = new EntitySchema<AgentDefinition>({
  name: "AgentDefinition",
  tableName: "agents",
  columns: {
    ...baseColumns,
    ownerId: { name: "owner_id", type: "text" },
    name: { type: "text" },
    systemPrompt: { name: "system_prompt", type: "text" },
  },
  indices: [{ name: "agents_owner", columns: ["ownerId"] }],
  checks: [
    {
      name: "agents_name_check",
      expression: `length(name) BETWEEN 1 AND ${agentLimits.nameLength}`,
    },
    {
      name: "agents_system_prompt_check",
      expression: `length(system_prompt) BETWEEN 1 AND ${agentLimits.systemPromptLength}`,
    },
  ],
});
