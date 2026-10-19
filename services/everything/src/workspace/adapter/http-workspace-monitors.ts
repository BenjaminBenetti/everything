import {
  monitorLimits,
  type MonitorInput,
  type MonitorResult,
} from "@everything/workspace-contracts/monitor";
import type { WorkspaceMonitors } from "../interface/workspace-monitors.js";
import { WorkspaceHttpClient } from "./workspace-http-client.js";

/** Reach a teammate's monitors through the same authenticated internal Service as its tools. */
export class HttpWorkspaceMonitors implements WorkspaceMonitors {
  // ===========================================
  // Construction
  // ===========================================

  private readonly client: WorkspaceHttpClient;

  /** Inject only the namespace, controller key, and replaceable HTTP transport. */
  constructor(namespace: string, key: string, fetcher: typeof fetch = fetch) {
    this.client = new WorkspaceHttpClient(namespace, key, fetcher);
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Starting returns once the process is launched; it is never retried, so it cannot start twice. */
  start(
    agentId: string,
    input: MonitorInput,
    signal?: AbortSignal,
  ): Promise<MonitorResult> {
    return this.client.request(agentId, "/monitors", input, 30_000, signal);
  }

  /** Allow the pod's long poll to finish before the request times out. */
  wait(
    agentId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<MonitorResult> {
    return this.client.request(
      agentId,
      `/monitors/${encodeURIComponent(id)}/wait`,
      {},
      (monitorLimits.waitSeconds + 10) * 1000,
      signal,
    );
  }

  /** Stop the command; the pod returns its outcome once descendants are gone. */
  cancel(
    agentId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<MonitorResult> {
    return this.client.request(
      agentId,
      `/monitors/${encodeURIComponent(id)}/cancel`,
      {},
      30_000,
      signal,
    );
  }
}
