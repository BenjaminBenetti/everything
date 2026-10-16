import { Type } from "typebox";
import { workspaceStatuses } from "@everything/workspace-contracts/instance";

const status = Type.Union(
  workspaceStatuses.map((value) => Type.Literal(value)),
);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);

/** Installation-wide workspace instances expose safe state and usage measurements. */
export const workspaceListResponse = Type.Object({
  workspaces: Type.Array(
    Type.Object({
      type: Type.String(),
      name: Type.String(),
      status,
      resources: Type.Object({
        cpuCores: nullableNumber,
        memoryBytes: nullableNumber,
      }),
    }),
  ),
});

/** Recent workspace activity is scoped to the saved teammate and its owner. */
export const recentWorkspacesResponse = Type.Object({
  workspaces: Type.Array(
    Type.Object({
      type: Type.String(),
      name: Type.String(),
      status,
      lastInteractedAt: Type.String(),
    }),
  ),
  observedAt: Type.String(),
});

/** Deletion is accepted while the workspace runtime removes the instance asynchronously. */
export const workspaceDeletionResponse = Type.Object({});
