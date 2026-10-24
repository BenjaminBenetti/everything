import { randomUUID } from "node:crypto";
import { context } from "@opentelemetry/api";
import type { AgentSession } from "../interface/agent-session.js";
import type { TelemetryScope } from "../../telemetry/model/telemetry-scope.js";
import { TurnTelemetry, type TurnCancellation } from "./turn-telemetry.js";
import type { SessionRuntimeStatus } from "../model/runtime-status.js";
import {
  FastModeLimitedError,
  FastModeRejectedError,
} from "../error/runtime-errors.js";

/** Caller-safe failure text; provider details stay in the private session transcript. */
const runFailure =
  "Your teammate couldn’t finish replying. Check the model provider, then send a message to continue.";

/** Explain a refused Fast mode request with its recovery, and every other failure generically. */
function failureText(error: unknown): string {
  return error instanceof FastModeRejectedError ||
    error instanceof FastModeLimitedError
    ? error.message
    : runFailure;
}

/** One agent's loaded session, its in-flight turn, and the public status of that turn. */
export class AgentRuntime {
  // ===========================================
  // State
  // ===========================================

  private current: Omit<
    SessionRuntimeStatus,
    "mainRunning" | "backgroundCount" | "compactionStartedAt"
  >;
  private completion: Promise<void> = Promise.resolve();
  private cancellation: TurnCancellation | undefined;

  // ===========================================
  // Construction
  // ===========================================

  /**
   * Track a freshly opened session, idle until its first turn, recording its turns' telemetry for
   * the owner and teammate in `scope`.
   */
  constructor(
    private readonly session: AgentSession,
    private readonly scope?: TelemetryScope,
  ) {
    this.current = {
      status: "idle",
      compacting: false,
      typing: false,
      sessionId: session.id,
      runId: null,
      error: null,
    };
  }

  // ===========================================
  // Accessors
  // ===========================================

  /** Expose only the private-family capability to authorized API operations. */
  get subagents(): AgentSession["subagents"] {
    return this.session.subagents;
  }

  /** Combine the latest turn state with live activity and background teammate counts. */
  get status(): SessionRuntimeStatus {
    const background = this.session.background;
    const running = this.current.status === "running" || background?.running;
    const compacting = Boolean(running && this.session.compacting);
    return {
      ...this.current,
      status: running
        ? "running"
        : background?.failed
          ? "error"
          : this.current.status,
      // A user turn counts until it settles, including its delivery reminders, and so does a woken main session.
      mainRunning:
        this.current.status === "running" || Boolean(background?.mainRunning),
      error: this.current.error ?? (background?.failed ? runFailure : null),
      compacting,
      compactionStartedAt: compacting ? this.session.compactionStartedAt : null,
      typing: Boolean(running && this.session.typing),
      backgroundCount: background?.activeCount ?? 0,
    };
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Start a turn in the background and return its run ID; an active turn must be stopped first. */
  start(text: string): string {
    if (this.current.status === "running")
      throw new Error("Stop the active turn before starting another");
    const runId = randomUUID();
    this.current = {
      status: "running",
      compacting: false,
      typing: false,
      sessionId: this.session.id,
      runId,
      error: null,
    };
    this.cancellation = undefined;
    this.completion = this.runTurn(text, runId);
    return runId;
  }

  /** Abort selected work and settle the active user turn before accepting a replacement. */
  async stop(scope: "turn" | "all" = "all"): Promise<void> {
    this.cancel(scope === "turn" ? "interrupted" : "stopped");
    await this.session.abort(scope);
    await this.completion;
    this.current = { ...this.current, status: "idle", error: null };
  }

  /** Stop active work and release the session's resources. */
  async close(): Promise<void> {
    this.cancel("closed");
    await this.stop();
    await this.session.dispose();
  }

  // ===========================================
  // Turn execution
  // ===========================================

  /** Begin prompting immediately, so an abort issued right after start reaches this turn, and record its outcome. */
  private async runTurn(text: string, runId: string): Promise<void> {
    const telemetry = new TurnTelemetry(this.scope, this.session.id, runId);
    try {
      await context.with(telemetry.context, () => this.session.prompt(text));
      telemetry.completed(this.cancellation);
      this.current = { ...this.current, status: "idle" };
    } catch (error) {
      telemetry.failed(error, this.cancellation);
      this.current = {
        ...this.current,
        status: "error",
        error: failureText(error),
      };
    }
  }

  /** Remember why the running turn is ending early, keeping the first reason given. */
  private cancel(reason: TurnCancellation): void {
    if (this.current.status === "running") this.cancellation ??= reason;
  }
}
