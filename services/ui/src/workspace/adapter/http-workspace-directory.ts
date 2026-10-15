import type {
  WorkspaceInstance,
  WorkspaceInstanceList,
  WorkspaceReference,
} from "@everything/workspace-contracts/instance";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { WorkspaceDirectory } from "../interface/workspace-directory.js";
import type { RecentWorkspaceList } from "@everything/workspace-contracts/activity";

/** Translate directory actions into authenticated, same-origin requests. */
export class HttpWorkspaceDirectory implements WorkspaceDirectory {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive HTTP policy from the application composition root. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Directory and controls
  // ===========================================

  /** Read activity through a teammate-scoped endpoint, independently of the shared directory. */
  recent(agentId: string, signal?: AbortSignal): Promise<RecentWorkspaceList> {
    return this.transport.request(
      `/v1/agents/${encodeURIComponent(agentId)}/workspaces`,
      signal ? { signal } : {},
    );
  }

  /** Read runtime state and resource measurements. */
  async list(signal?: AbortSignal): Promise<readonly WorkspaceInstance[]> {
    return (
      await this.transport.request<WorkspaceInstanceList>(
        "/v1/workspaces",
        signal ? { signal } : {},
      )
    ).workspaces;
  }

  /** Resume an existing instance without creating a new one. */
  async start(workspace: WorkspaceReference): Promise<void> {
    await this.transport.request("/v1/workspaces/start", {
      method: "POST",
      body: JSON.stringify(workspace),
    });
  }

  /** Stop an instance without removing its files. */
  async stop(workspace: WorkspaceReference): Promise<void> {
    await this.transport.request("/v1/workspaces/stop", {
      method: "POST",
      body: JSON.stringify(workspace),
    });
  }

  /** Request removal after the user confirms deletion. */
  async delete(workspace: WorkspaceReference): Promise<void> {
    await this.transport.request("/v1/workspaces", {
      method: "DELETE",
      body: JSON.stringify(workspace),
    });
  }
}
