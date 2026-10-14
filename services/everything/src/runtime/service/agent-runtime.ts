import { randomUUID } from "node:crypto";
import type { AgentSession } from "../interface/agent-session.js";
import type { RuntimeStatus } from "../model/runtime-status.js";

/** Caller-safe failure text; provider details stay in the private session transcript. */
const runFailure =
  "Your teammate couldn’t finish replying. Check the model provider, then send a message to continue.";

/** One agent's loaded session, its in-flight turn, and the public status of that turn. */
export class AgentRuntime {
  // ===========================================
  // State
  // ===========================================

  private current: Omit<RuntimeStatus, "backgroundCount">;
  private completion: Promise<void> = Promise.resolve();

  // ===========================================
  // Construction
  // ===========================================

  /** Track a freshly opened session, idle until its first turn. */
  constructor(private readonly session: AgentSession) {
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

  /** Combine the latest turn state with live activity and background teammate counts. */
  get status(): RuntimeStatus {
    const background = this.session.background;
    const running = this.current.status === "running" || background?.running;
    return {
      ...this.current,
      status: running
        ? "running"
        : background?.failed
          ? "error"
          : this.current.status,
      error: this.current.error ?? (background?.failed ? runFailure : null),
      compacting: Boolean(running && this.session.compacting),
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
    this.completion = this.runTurn(text);
    return runId;
  }

  /** Abort selected work and settle the active user turn before accepting a replacement. */
  async stop(scope: "turn" | "all" = "all"): Promise<void> {
    await this.session.abort(scope);
    await this.completion;
    this.current = { ...this.current, status: "idle", error: null };
  }

  /** Stop active work and release the session's resources. */
  async close(): Promise<void> {
    await this.stop();
    await this.session.dispose();
  }

  // ===========================================
  // Turn execution
  // ===========================================

  /** Begin prompting immediately, so an abort issued right after start reaches this turn, and record its outcome. */
  private async runTurn(text: string): Promise<void> {
    try {
      await this.session.prompt(text);
      this.current = { ...this.current, status: "idle" };
    } catch {
      this.current = { ...this.current, status: "error", error: runFailure };
    }
  }
}
