import type { WorkspaceReference, WorkspaceStatus } from "./instance.js";

/** Bound the conversation overview and the brief indication of teammate interaction. */
export const workspaceActivityPolicy = {
  limit: 10,
  activeMilliseconds: 30_000,
};

/** A workspace explicitly used by this teammate or one of its private forks. */
export interface RecentWorkspace extends WorkspaceReference {
  readonly status: WorkspaceStatus;
  readonly lastInteractedAt: string;
}

/** Include server time so activity expires correctly even when the browser clock differs. */
export interface RecentWorkspaceList {
  readonly workspaces: readonly RecentWorkspace[];
  readonly observedAt: string;
}
