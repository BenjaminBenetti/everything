import type { WorkerSettings } from "@everything/settings-contracts";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { WorkspaceSettings } from "../interface/workspace-settings.js";

/** Translate workspace settings into the public API contract. */
export class HttpWorkspaceSettings implements WorkspaceSettings {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive transport policy independently from the domain adapter. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read the worker settings. */
  workers(signal?: AbortSignal): Promise<WorkerSettings> {
    return this.transport.request<WorkerSettings>(
      "/v1/settings/workers",
      signal ? { signal } : {},
    );
  }

  /** Replace the worker settings. */
  updateWorkers(settings: WorkerSettings): Promise<WorkerSettings> {
    return this.transport.request<WorkerSettings>("/v1/settings/workers", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  }
}
