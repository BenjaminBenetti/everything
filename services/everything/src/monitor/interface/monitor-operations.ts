import type {
  MonitorInput,
  MonitorResult,
} from "@everything/workspace-contracts/monitor";

/** The authenticated owner and teammate a monitor belongs to and reports back to. */
export interface MonitorScope {
  readonly ownerId: string;
  readonly agentId: string;
}

/** A monitor request: the pod command plus what the completion event should do with the result. */
export interface MonitorRequest extends MonitorInput {
  readonly instructions?: string;
}

/** A running monitor as listed to its teammate. */
export interface MonitorSummary {
  readonly id: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly origin: string;
  readonly startedAt: string;
  readonly timeoutSeconds: number;
  readonly log: string;
}

/** Monitor operations bound into one teammate's tools. */
export interface MonitorOperations {
  /** Start a command and report its completion to `scope`'s teammate; `origin` names the calling session. */
  start(
    scope: MonitorScope,
    origin: string,
    input: MonitorRequest,
    signal?: AbortSignal,
  ): Promise<MonitorSummary>;
  /** List this teammate's monitors that have not reported yet. */
  list(scope: MonitorScope): MonitorSummary[];
  /** Stop a monitor without a completion event and return how it ended. */
  stop(scope: MonitorScope, id: string): Promise<MonitorResult>;
}

/** Lifecycle hooks for the conversation coordinator and process shutdown. */
export interface MonitorLifecycle {
  /**
   * Stop a teammate's monitors without completion events, for Stop and deletion, refusing new ones
   * until `stopWork`, which stops the teammate's runtime, has settled.
   */
  stopAgent(agentId: string, stopWork?: () => Promise<void>): Promise<void>;
  /** Stop every monitor and refuse new ones. */
  close(): Promise<void>;
}

/** Deliver a completion event through the teammate's wakeup path. */
export interface MonitorWakeups {
  /**
   * Accept one event for a temporary private session; a resolved promise means it was accepted. An
   * aborted `signal` withdraws the event if it has not been accepted yet.
   */
  wakeup(
    scope: MonitorScope,
    input: { task: string; context: boolean },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Why a completion event was not delivered. */
export interface MonitorDeliveryFailure {
  readonly agentId: string;
  readonly monitorId: string;
  readonly code: string;
}
