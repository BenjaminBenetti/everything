import type {
  WorkspaceInstance,
  WorkspaceStatus,
} from "@everything/workspace-contracts/instance";

export const workspaceStatusLabels: Record<WorkspaceStatus, string> = {
  creating: "Creating",
  cloning: "Cloning",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
  stopping: "Stopping…",
  starting: "Starting…",
  deleting: "Deleting…",
  rebuilding: "Rebuilding",
  unknown: "Status unavailable",
};

/** Search instance and type names, then sort the visible groups and their cards. */
export function groupWorkspaces(
  workspaces: readonly WorkspaceInstance[],
  search: string,
): [string, WorkspaceInstance[]][] {
  const term = search.trim().toLocaleLowerCase();
  const groups = new Map<string, WorkspaceInstance[]>();
  for (const workspace of workspaces) {
    if (
      !`${workspace.name} ${workspace.type}`.toLocaleLowerCase().includes(term)
    )
      continue;
    const group = groups.get(workspace.type) ?? [];
    group.push(workspace);
    groups.set(workspace.type, group);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([type, items]) => [
      type,
      items.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      ),
    ]);
}

/** Show measured CPU in cores without implying unavailable usage is zero. */
export function formatWorkspaceCpu(cores: number | null): string {
  if (cores === null) return "—";
  if (cores > 0 && cores < 0.001) return "<0.001 cores";
  return `${cores.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${cores === 1 ? "core" : "cores"}`;
}

/** Format memory in binary units, keeping unknown measurements explicit. */
export function formatWorkspaceMemory(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent =
    bytes > 0
      ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
      : 0;
  return `${(bytes / 1024 ** exponent).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[exponent]}`;
}
