import { workspacePath } from "@everything/workspace-contracts/mount";

/** Resolve only image-node URLs, with an explicit conversation identity and one Markdown URL decode. */
export function workspaceImageReference(
  source: string | undefined,
  agentId?: string,
): string | undefined {
  if (!source) return undefined;
  if (
    /^https?:\/\//i.test(source) ||
    source.startsWith("//") ||
    source.startsWith("/v1/")
  )
    return source;
  if (!agentId || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("#"))
    return undefined;
  let requested: string;
  try {
    requested = decodeURIComponent(source);
  } catch {
    return undefined;
  }
  if (
    /[\u0000-\u001f\u007f\\]/u.test(requested) ||
    requested.split("/").includes("..")
  )
    return undefined;
  if (
    requested.startsWith("/") &&
    !requested.startsWith(`${workspacePath(agentId)}/`)
  )
    return undefined;
  return `/v1/agents/${encodeURIComponent(agentId)}/workspace-image?${new URLSearchParams({ path: requested })}`;
}
