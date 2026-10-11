import type { Agent } from "@everything/agent-contracts";
import type { AgentDefinition } from "../model/agent.js";

/** Exclude ownership and storage details from the shared public representation. */
export function representAgent(agent: AgentDefinition): Agent {
  const { id, name, systemPrompt, createdAt } = agent;
  return { id, name, systemPrompt, createdAt };
}
