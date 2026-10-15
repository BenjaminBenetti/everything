import type { WorkspaceResources } from "@everything/workspace-contracts/instance";

/** Resource measurements keyed by the runtime's container identity. */
export interface FleetResources {
  /** Read usage in one batch; missing entries mean measurements are unavailable. */
  read(
    containerIds: readonly string[],
  ): Promise<ReadonlyMap<string, WorkspaceResources>>;
}
