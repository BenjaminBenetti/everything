import type {
  GeneralSettings,
  TeammateOrder,
  WorkerSettings,
} from "@everything/settings-contracts";
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

  /** Read the signed-in owner's general settings. */
  general(signal?: AbortSignal): Promise<GeneralSettings> {
    return this.transport.request<GeneralSettings>(
      "/v1/settings/general",
      signal ? { signal } : {},
    );
  }

  /** Replace the signed-in owner's general settings. */
  updateGeneral(settings: GeneralSettings): Promise<GeneralSettings> {
    return this.transport.request<GeneralSettings>("/v1/settings/general", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  }

  /** Read the signed-in owner's teammate order. */
  teammateOrder(signal?: AbortSignal): Promise<TeammateOrder> {
    return this.transport.request<TeammateOrder>(
      "/v1/settings/teammate-order",
      signal ? { signal } : {},
    );
  }

  /** Replace the signed-in owner's teammate order. */
  updateTeammateOrder(order: TeammateOrder): Promise<TeammateOrder> {
    return this.transport.request<TeammateOrder>(
      "/v1/settings/teammate-order",
      { method: "PUT", body: JSON.stringify(order) },
    );
  }

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
