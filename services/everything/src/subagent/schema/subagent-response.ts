import { Type } from "typebox";

/** Private background identity shared by creation, wakeup, messaging, and listing. */
export const subagentResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  parentId: Type.String({ description: "main or the parent subagent's UUID." }),
  status: Type.Union(
    ["running", "queued", "idle", "stopped", "error"].map((status) =>
      Type.Literal(status),
    ),
  ),
});

/** Every reachable background session in this teammate's family. */
export const subagentListResponse = Type.Object({
  subagents: Type.Array(subagentResponse),
});
