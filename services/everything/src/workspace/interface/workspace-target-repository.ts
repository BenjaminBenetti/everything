import type { Repository } from "@everything/persistence/repository";
import type {
  WorkspaceTarget,
  WorkspaceTargetScope,
} from "../model/workspace-target.js";

/** Internal maintenance queries keep profile and provider details out of the pod controller. */
export interface WorkspaceTargetRepository extends Repository<
  WorkspaceTarget,
  WorkspaceTargetScope
> {}

/** Reconciliation can discover desired work but cannot change teammate records. */
export type WorkspaceTargetSource = Pick<
  WorkspaceTargetRepository,
  "list" | "getById"
>;
