import { setTimeout as delay } from "node:timers/promises";
import pRetry from "p-retry";
import { ApplicationError } from "@everything/errors";
import {
  monitorLimits,
  type MonitorResult,
} from "@everything/workspace-contracts/monitor";
import type { WorkspaceMonitors } from "../../workspace/interface/workspace-monitors.js";
import {
  WorkspaceResourceNotFoundError,
  WorkspaceUnavailableError,
} from "../../workspace/error/workspace-errors.js";
import {
  MonitorNotFoundError,
  MonitorStoppedError,
  MonitorsUnavailableError,
} from "../error/monitor-errors.js";
import type {
  MonitorActivity,
  MonitorLifecycle,
  MonitorOperations,
  MonitorRequest,
  MonitorDeliveryFailure,
  MonitorScope,
  MonitorSummary,
  MonitorWakeups,
} from "../interface/monitor-operations.js";
import {
  defaultMonitorDeliveryPolicy,
  type MonitorDeliveryPolicy,
} from "../model/monitor-policy.js";
import {
  monitorNotification,
  type MonitorContext,
  type MonitorOutcome,
} from "../model/monitor-notification.js";

/** A monitor Everything follows until its single completion event has been handled. */
interface TrackedMonitor {
  readonly scope: MonitorScope;
  readonly context: MonitorContext;
  /** Aborts following and delivery without a completion event. */
  readonly following: AbortController;
  /** The teammate's pending stop request; its outcome is returned there instead of in an event. */
  stopping: Promise<MonitorResult> | undefined;
  delivering: boolean;
}

/**
 * Start commands in a teammate's pod, follow them by long-polling, and deliver each outcome at most
 * once as a fresh-context wakeup to the teammate that started it. The recipient comes from the tool's
 * construction, never from model input. Wakeups refused at capacity or while inference is unavailable
 * are retried with bounded backoff; an accepted wakeup, or any failure that may have been accepted, is
 * never retried. Following lives in this process: after a restart the pod's lease stops orphaned
 * commands and nothing is replayed.
 */
export class MonitorService
  implements MonitorOperations, MonitorActivity, MonitorLifecycle
{
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly monitors = new Map<string, TrackedMonitor>();
  /** Counts each teammate's stops, so a start that raced one is stopped too. */
  private readonly stops = new Map<string, number>();
  /** Counts each teammate's stops still in progress; their new starts are refused. */
  private readonly stoppingAgents = new Map<string, number>();
  private closed = false;

  /** Receive the pod transport, the wakeup path, failure reporting, and timing policy. */
  constructor(
    private readonly workspace: WorkspaceMonitors,
    private readonly wakeups: MonitorWakeups,
    private readonly reportFailure: (failure: MonitorDeliveryFailure) => void,
    private readonly policy: MonitorDeliveryPolicy = defaultMonitorDeliveryPolicy,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Launch the command and begin following it; the caller's turn is not held or bound to it. */
  async start(
    scope: MonitorScope,
    origin: string,
    input: MonitorRequest,
    signal?: AbortSignal,
  ): Promise<MonitorSummary> {
    if (this.closed) throw new MonitorsUnavailableError();
    // Work the teammate's Stop is still ending may call tools; it must not start commands that outlive it.
    if (this.stoppingAgents.has(scope.agentId)) throw new MonitorStoppedError();
    const timeoutSeconds =
      input.timeoutSeconds ?? monitorLimits.defaultTimeoutSeconds;
    const stops = this.stops.get(scope.agentId) ?? 0;
    const started = await this.workspace
      .start(
        scope.agentId,
        {
          command: input.command,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          timeoutSeconds,
        },
        signal,
      )
      .catch((error: unknown) => {
        // A pod still running an image without monitors has no such route.
        throw error instanceof WorkspaceResourceNotFoundError
          ? new WorkspaceUnavailableError()
          : error;
      });
    const tracked: TrackedMonitor = {
      scope: { ownerId: scope.ownerId, agentId: scope.agentId },
      context: {
        id: started.id,
        command: input.command,
        cwd: input.cwd ?? null,
        instructions: input.instructions ?? null,
        origin,
        timeoutSeconds,
        startedAt: started.startedAt,
        log: started.log,
      },
      following: new AbortController(),
      stopping: undefined,
      delivering: false,
    };
    this.monitors.set(started.id, tracked);
    if (this.closed || (this.stops.get(scope.agentId) ?? 0) !== stops) {
      // Shutdown or the teammate's Stop began while the pod was starting the command.
      await this.halt(tracked);
      throw this.closed
        ? new MonitorsUnavailableError()
        : new MonitorStoppedError();
    }
    void this.follow(tracked);
    return this.summary(tracked);
  }

  /** List monitors whose completion has not been handled, for the owning teammate only. */
  list(scope: MonitorScope): MonitorSummary[] {
    return [...this.monitors.values()]
      .filter((tracked) => this.owns(tracked, scope))
      .map((tracked) => this.summary(tracked));
  }

  /** Count the owning teammate's commands still running; one whose outcome is being delivered has ended. */
  runningCount(scope: MonitorScope): number {
    return [...this.monitors.values()].filter(
      (tracked) => this.owns(tracked, scope) && !tracked.delivering,
    ).length;
  }

  /** Stop the command and return its outcome directly instead of in a completion event. */
  stop(scope: MonitorScope, id: string): Promise<MonitorResult> {
    const tracked = this.monitors.get(id);
    if (!tracked || !this.owns(tracked, scope) || tracked.delivering)
      return Promise.reject(new MonitorNotFoundError());
    // Concurrent stops share one request, so following waits for a single answer.
    tracked.stopping ??= this.cancel(tracked).finally(() => {
      tracked.stopping = undefined;
    });
    return tracked.stopping;
  }

  /** Cancel in the pod; while this is pending, following holds any outcome it observes. */
  private async cancel(tracked: TrackedMonitor): Promise<MonitorResult> {
    const { id } = tracked.context;
    try {
      const result = await this.workspace.cancel(tracked.scope.agentId, id);
      tracked.following.abort();
      this.monitors.delete(id);
      return result;
    } catch (error) {
      if (error instanceof WorkspaceResourceNotFoundError) {
        tracked.following.abort();
        this.monitors.delete(id);
        throw new MonitorNotFoundError();
      }
      // The pod may still be running it, so following continues and reports its outcome as usual.
      throw error;
    }
  }

  // ===========================================
  // Lifecycle
  // ===========================================

  /**
   * Stop a teammate's monitors without events, for the user's Stop action and teammate deletion. New
   * starts are refused until `stopWork`, which ends the teammate's turns and tool calls, has settled,
   * and starts already in flight are stopped when they return, so no work Stop ends leaves one running.
   */
  async stopAgent(
    agentId: string,
    stopWork?: () => Promise<void>,
  ): Promise<void> {
    this.stops.set(agentId, (this.stops.get(agentId) ?? 0) + 1);
    this.stoppingAgents.set(
      agentId,
      (this.stoppingAgents.get(agentId) ?? 0) + 1,
    );
    try {
      const halting = Promise.all(
        [...this.monitors.values()]
          .filter((tracked) => tracked.scope.agentId === agentId)
          .map((tracked) => this.halt(tracked)),
      );
      try {
        await stopWork?.();
      } finally {
        await halting;
      }
    } finally {
      const remaining = this.stoppingAgents.get(agentId)! - 1;
      if (remaining === 0) this.stoppingAgents.delete(agentId);
      else this.stoppingAgents.set(agentId, remaining);
    }
  }

  /** Refuse new monitors and stop every command, so none outlives the process that would report it. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.monitors.values()].map((tracked) => this.halt(tracked)),
    );
  }

  // ===========================================
  // Following and delivery
  // ===========================================

  /** Long-poll the pod until the command ends or is lost, then deliver once and forget it. */
  private async follow(tracked: TrackedMonitor): Promise<void> {
    const { signal } = tracked.following;
    try {
      const outcome = await this.outcome(tracked, signal);
      // A pending stop returns the outcome itself if it succeeds; if it fails, the event is still owed.
      while (tracked.stopping && !signal.aborted)
        await tracked.stopping.catch(() => {});
      if (!outcome || signal.aborted) return;
      tracked.delivering = true;
      await this.deliver(tracked, outcome, signal);
    } finally {
      this.monitors.delete(tracked.context.id);
    }
  }

  /** Repeat bounded waits, reporting the monitor lost if the pod forgot it or stays unreachable. */
  private async outcome(
    tracked: TrackedMonitor,
    signal: AbortSignal,
  ): Promise<MonitorOutcome | undefined> {
    const { agentId } = tracked.scope;
    let unreachableSince: number | undefined;
    while (!signal.aborted) {
      try {
        const result = await this.workspace.wait(
          agentId,
          tracked.context.id,
          signal,
        );
        unreachableSince = undefined;
        if (result.status !== "running") return result;
      } catch (error) {
        if (signal.aborted) return undefined;
        if (error instanceof WorkspaceResourceNotFoundError)
          return this.lost(
            "The teammate's workspace no longer has this monitor, usually because it restarted, which stops running commands.",
          );
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince >= this.policy.unreachableMs) {
          // Best effort: the pod's lease stops the command if this cannot reach it.
          void this.workspace
            .cancel(agentId, tracked.context.id, AbortSignal.timeout(5_000))
            .catch(() => {});
          return this.lost(
            "The teammate's workspace stopped responding, so the command was stopped or may have been interrupted.",
          );
        }
        await delay(this.policy.waitRetryMs, undefined, { signal }).catch(
          () => {},
        );
      }
    }
    return undefined;
  }

  /** Request one fresh-context wakeup, retrying only refusals that guarantee nothing was accepted. */
  private async deliver(
    tracked: TrackedMonitor,
    outcome: MonitorOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const task = monitorNotification(tracked.context, outcome);
    try {
      await pRetry(
        () =>
          this.wakeups.wakeup(tracked.scope, { task, context: false }, signal),
        {
          retries: this.policy.retries,
          minTimeout: this.policy.minRetryMs,
          maxTimeout: this.policy.maxRetryMs,
          signal,
          shouldRetry: ({ error }) => this.retryable(error),
        },
      );
    } catch (error) {
      if (signal.aborted) return;
      this.reportFailure({
        agentId: tracked.scope.agentId,
        monitorId: tracked.context.id,
        code: error instanceof ApplicationError ? error.code : "UNEXPECTED",
      });
    }
  }

  /** Capacity and unavailable-inference refusals happen before acceptance; shutdown is final. */
  private retryable(error: unknown): boolean {
    return (
      error instanceof ApplicationError &&
      (error.status === 409 ||
        (error.status === 503 && error.code !== "SHUTTING_DOWN"))
    );
  }

  /** Stop following and kill the command without an event, waiting at most five seconds for the pod. */
  private async halt(tracked: TrackedMonitor): Promise<void> {
    tracked.following.abort();
    this.monitors.delete(tracked.context.id);
    // A delivery may be waiting for the teammate lock the caller holds, so it is not awaited here.
    await this.workspace
      .cancel(
        tracked.scope.agentId,
        tracked.context.id,
        AbortSignal.timeout(5_000),
      )
      .catch(() => {});
  }

  // ===========================================
  // Reporting
  // ===========================================

  /** Describe an outcome the pod can no longer report. */
  private lost(reason: string): MonitorOutcome {
    return { status: "lost", reason, finishedAt: new Date().toISOString() };
  }

  /** Both the owner and the teammate must match; other teammates' monitors look absent. */
  private owns(tracked: TrackedMonitor, scope: MonitorScope): boolean {
    return (
      tracked.scope.ownerId === scope.ownerId &&
      tracked.scope.agentId === scope.agentId
    );
  }

  /** Summarize what the teammate started, keeping long commands short. */
  private summary({ context }: TrackedMonitor): MonitorSummary {
    return {
      id: context.id,
      command:
        context.command.length > 200
          ? `${context.command.slice(0, 200)}…`
          : context.command,
      cwd: context.cwd,
      origin: context.origin,
      startedAt: context.startedAt,
      timeoutSeconds: context.timeoutSeconds,
      log: context.log,
    };
  }
}
