import type {
  MonitorInput,
  MonitorResult,
} from "@everything/workspace-contracts/monitor";

/** Background commands in a teammate's tools pod, independent of their transport. */
export interface WorkspaceMonitors {
  /** Start a command in this teammate's container and return without waiting for it. */
  start(
    agentId: string,
    input: MonitorInput,
    signal?: AbortSignal,
  ): Promise<MonitorResult>;
  /** Wait a bounded time for the command to finish, renewing its lease in the pod. */
  wait(
    agentId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<MonitorResult>;
  /** Stop the command and its descendants and return how it ended. */
  cancel(
    agentId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<MonitorResult>;
}
