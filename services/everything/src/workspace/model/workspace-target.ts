import type { OwnedEntity } from "@everything/persistence/entity";

/** Minimal durable identity needed to reconcile a teammate's tools pod. */
export interface WorkspaceTarget extends OwnedEntity {}

/** Explicit internal maintenance scope; never used by user-facing ownership queries. */
export interface WorkspaceTargetScope {
  readonly ownership: "all";
}
