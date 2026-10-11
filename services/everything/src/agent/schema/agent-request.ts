import { Type, type Static } from "typebox";
import { nonBlankText } from "../../http/schema/text-schema.js";
import { agentLimits } from "../model/agent.js";

/** Route parameters identifying one agent. */
export const agentParams = Type.Object(
  { agentId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

/** Validated route parameters identifying one agent. */
export type AgentParams = Static<typeof agentParams>;

/** Request body for creating a user-named agent. */
export const createAgentBody = Type.Object(
  {
    name: nonBlankText(agentLimits.nameLength),
    systemPrompt: nonBlankText(agentLimits.systemPromptLength),
  },
  { additionalProperties: false },
);

/** Validated request body for creating a user-named agent. */
export type CreateAgentBody = Static<typeof createAgentBody>;
