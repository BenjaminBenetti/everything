import type { ListOptions } from "@everything/persistence/repository";
import {
  workspaceActivityPolicy,
  type RecentWorkspaceList,
} from "@everything/workspace-contracts/activity";
import type { WorkspaceReference } from "@everything/workspace-contracts/instance";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type {
  WorkspaceActivityReader,
  WorkspaceActivityRecorder,
  WorkspaceActivityScope,
  WorkspaceInteractionRepository,
  WorkspaceStates,
} from "../interface/workspace-activity.js";
import type { WorkspaceInteractionRecord } from "../model/workspace-interaction.js";

/** Order distinct workspaces by recency, resolving tied timestamps deterministically. */
export const recentWorkspaceListing: ListOptions<WorkspaceInteractionRecord> = {
  order: { lastInteractedAt: "DESC", id: "DESC" },
  take: workspaceActivityPolicy.limit,
};

/** Combine durable teammate interaction history with live workspace lifecycle state. */
export class WorkspaceActivity
  implements WorkspaceActivityReader, WorkspaceActivityRecorder
{
  // ===========================================
  // Construction
  // ===========================================

  /** Keep authorization, persistence, current states, and time independently replaceable. */
  constructor(
    private readonly agents: Pick<AgentCatalog, "get">,
    private readonly interactions: Pick<
      WorkspaceInteractionRepository,
      "list" | "touch"
    >,
    private readonly workspaces: WorkspaceStates,
    private readonly now: () => number = Date.now,
  ) {}

  // ===========================================
  // Activity
  // ===========================================

  /** Store only the server-bound teammate identity and workspace names, never commands or output. */
  touch(
    scope: WorkspaceActivityScope,
    workspace: WorkspaceReference,
  ): Promise<void> {
    return this.interactions.touch(
      scope,
      workspace,
      new Date(this.now()).toISOString(),
    );
  }

  /** Authorize recent activity and omit deleted workspaces only after a successful lifecycle lookup. */
  async recent(scope: WorkspaceActivityScope): Promise<RecentWorkspaceList> {
    await this.agents.get(scope.ownerId, scope.agentId);
    const interactions = await this.interactions.list(scope);
    const states = interactions.length ? await this.workspaces.states() : [];
    const byIdentity = new Map(
      states.map((item) => [
        JSON.stringify([item.type, item.name]),
        item.status,
      ]),
    );
    return {
      observedAt: new Date(this.now()).toISOString(),
      workspaces: interactions.flatMap(({ type, name, lastInteractedAt }) => {
        const status = byIdentity.get(JSON.stringify([type, name]));
        return status === undefined
          ? []
          : [{ type, name, lastInteractedAt, status }];
      }),
    };
  }
}
