import AsyncLock from "async-lock";
import { Value } from "typebox/value";
import {
  workspaceStatuses,
  type WorkspaceInstance,
  type WorkspaceReference,
} from "@everything/workspace-contracts/instance";
import type { WorkspaceInstances } from "../../workspace/interface/workspace-instances.js";
import type { WorkspaceStates } from "../../workspace/interface/workspace-activity.js";
import {
  WorkspaceInstanceConflictError,
  WorkspaceInstanceNotFoundError,
  WorkspaceInstancesUnavailableError,
} from "../../workspace/error/workspace-instance-errors.js";
import type { FleetTools } from "../interface/fleet-tools.js";
import type { FleetResources } from "../interface/fleet-resources.js";
import {
  fleetInstanceListSchema,
  fleetJobSchema,
  type FleetInstance,
} from "../schema/fleet-instance.js";

/** Translate Fleet instances into shared workspaces and enforce lifecycle policy. */
export class FleetWorkspaces implements WorkspaceInstances, WorkspaceStates {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly operations = new AsyncLock();

  /** Keep runtime transport and resource measurement behind focused contracts. */
  constructor(
    private readonly tools: FleetTools,
    private readonly resources: FleetResources,
  ) {}

  // ===========================================
  // Directory and lifecycle
  // ===========================================

  /** Read current lifecycle state without the metrics required by the full workspace directory. */
  async states(): ReturnType<WorkspaceStates["states"]> {
    return (await this.instances()).map((instance) => ({
      type: instance.fleet,
      name: instance.instance,
      status:
        workspaceStatuses.find((status) => status === instance.status) ??
        "unknown",
    }));
  }

  /** Publish names, lifecycle state, and available resource measurements. */
  async list(): Promise<readonly WorkspaceInstance[]> {
    const instances = await this.instances();
    const usage = await this.resources.read(
      instances
        .filter((item) => item.status === "running")
        .map((item) => item.container_id ?? ""),
    );
    return instances.map((instance) => ({
      type: instance.fleet,
      name: instance.instance,
      status:
        workspaceStatuses.find((status) => status === instance.status) ??
        "unknown",
      resources:
        instance.status === "stopped"
          ? { cpuCores: 0, memoryBytes: 0 }
          : (usage.get(instance.container_id ?? "") ?? {
              cpuCores: null,
              memoryBytes: null,
            }),
    }));
  }

  /** Resume only stopped instances; already running instances need no action. */
  async start(workspace: WorkspaceReference): Promise<void> {
    await this.transition(workspace, "start", "stopped", "running");
  }

  /** Stop only running instances, retaining the workspace's files. */
  async stop(workspace: WorkspaceReference): Promise<void> {
    await this.transition(workspace, "stop", "running", "stopped");
  }

  /** Recheck stopped state on the server before starting irreversible removal. */
  async delete(workspace: WorkspaceReference): Promise<void> {
    await this.transition(workspace, "down", "stopped");
  }

  // ===========================================
  // Runtime boundary
  // ===========================================

  /** Validate Fleet's structured listing instead of trusting a transport cast. */
  private async instances(type?: string): Promise<readonly FleetInstance[]> {
    const result = await this.call("fleet_list", type ? { fleet: type } : {});
    if (!Value.Check(fleetInstanceListSchema, result))
      throw new WorkspaceInstancesUnavailableError();
    return result.instances;
  }

  /** Serialize each instance's actions and check fresh state before issuing a command. */
  private async transition(
    workspace: WorkspaceReference,
    action: "start" | "stop" | "down",
    expected: string,
    settled?: string,
  ): Promise<void> {
    await this.operations.acquire(
      JSON.stringify([workspace.type, workspace.name]),
      async () => {
        const instance = (await this.instances(workspace.type)).find(
          (item) =>
            item.fleet === workspace.type && item.instance === workspace.name,
        );
        if (!instance) throw new WorkspaceInstanceNotFoundError();
        if (instance.status === settled) return;
        if (instance.status !== expected)
          throw new WorkspaceInstanceConflictError();
        const result = await this.call(`fleet_${action}`, {
          fleet: workspace.type,
          instance: workspace.name,
        });
        if (
          !Value.Check(fleetJobSchema, result) ||
          (result.done ? result.success !== true : action !== "down")
        ) {
          throw new WorkspaceInstancesUnavailableError();
        }
      },
    );
  }

  /** Hide daemon paths, tool output, and other internal failure details. */
  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.tools.call(name, args);
    } catch {
      throw new WorkspaceInstancesUnavailableError();
    }
  }
}
