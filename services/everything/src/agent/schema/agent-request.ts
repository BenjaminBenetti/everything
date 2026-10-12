import { Type, type Static } from "typebox";
import { agentAvatarIds } from "@everything/agent-contracts/avatar";
import { nonBlankText } from "../../http/schema/text-schema.js";
import { agentLimits } from "../model/agent.js";
import { providerIds, providerLimits } from "@everything/provider-contracts";
import { inferenceEfforts } from "@everything/provider-contracts/inference";

/** Require a complete selection so changing providers cannot retain an incompatible model. */
const inference = Type.Object(
  {
    provider: Type.Union(providerIds.map((id) => Type.Literal(id))),
    model: nonBlankText(providerLimits.modelLength),
    effort: Type.Union(inferenceEfforts.map((effort) => Type.Literal(effort))),
  },
  { additionalProperties: false },
);

/** Only built-in choices may be stored; arbitrary image URLs are not accepted. */
const avatarId = Type.Union(agentAvatarIds.map((id) => Type.Literal(id)));

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
    avatarId: Type.Optional(avatarId),
    inference: Type.Optional(inference),
  },
  { additionalProperties: false },
);

/** Validated request body for creating a user-named agent. */
export type CreateAgentBody = Static<typeof createAgentBody>;

/** Accept at least one editable field, without accepting ownership or runtime state. */
export const updateAgentBody = Type.Object(
  {
    name: Type.Optional(nonBlankText(agentLimits.nameLength)),
    systemPrompt: Type.Optional(nonBlankText(agentLimits.systemPromptLength)),
    avatarId: Type.Optional(avatarId),
    inference: Type.Optional(inference),
  },
  { additionalProperties: false, minProperties: 1 },
);

/** Validated input for the profile endpoint. */
export type UpdateAgentBody = Static<typeof updateAgentBody>;
