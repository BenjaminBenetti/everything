import { createHmac } from "node:crypto";

/** Derive a credential that authorizes only one tools pod, without sharing the controller key. */
export function workspaceToken(key: string, agentId: string): string {
  return createHmac("sha256", Buffer.from(key, "base64"))
    .update(`everything/workspace-api/v1/${agentId}`)
    .digest("hex");
}

/** Validate persisted identities before using them as resource names or volume subpaths. */
export function workspaceResourceName(agentId: string): string {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      agentId,
    )
  )
    throw new Error("Invalid teammate workspace identifier");
  return `teammate-${agentId}`;
}

export const workspaceLabels = {
  manager: "everything.work/managed-by",
  identity: "everything.work/teammate-id",
} as const;
export const workspaceManager = "workspace-controller";
