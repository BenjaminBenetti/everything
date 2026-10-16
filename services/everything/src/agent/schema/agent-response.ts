import { Type } from "typebox";
import { createAgentBody } from "./agent-request.js";

/** Public teammate fields share their input schemas and exclude ownership and persistence details. */
export const agentResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: createAgentBody.properties.name,
  systemPrompt: createAgentBody.properties.systemPrompt,
  avatarId: Type.Required(Type.Pick(createAgentBody, ["avatarId"])).properties
    .avatarId,
  inference: Type.Union([
    Type.Required(Type.Pick(createAgentBody, ["inference"])).properties
      .inference,
    Type.Null(),
  ]),
  createdAt: Type.String(),
});

/** Directory and recent-history endpoints return the same public representation. */
export const agentListResponse = Type.Object({
  agents: Type.Array(agentResponse),
});
