import type {
  MonitorInput,
  MonitorResult,
} from "@everything/workspace-contracts/monitor";

/** Background commands that outlive the request that started them, consumed by the HTTP server. */
export interface CommandMonitors {
  /** Start a command and return its running state without waiting for it. */
  start(input: MonitorInput): Promise<MonitorResult>;
  /** Return once the command finishes or `waitMs` passes, whichever is first; waiting renews its lease. */
  wait(id: string, waitMs: number): Promise<MonitorResult>;
  /** Stop a command and its descendants, returning how it ended. */
  cancel(id: string): Promise<MonitorResult>;
  /** Stop every running command before server shutdown. */
  close(): Promise<void>;
}
