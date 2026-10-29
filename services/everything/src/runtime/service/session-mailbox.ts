import { AsyncLocalStorage } from "node:async_hooks";
import { context } from "@opentelemetry/api";
import type {
  ForkableSession,
  SessionFork,
} from "../interface/session-forks.js";
import {
  withoutRun,
  withPromptSource,
} from "../../telemetry/service/telemetry-recorder.js";

/** Capture the completed turn before another queued message changes the live session state. */
interface TurnOutcome {
  readonly text: string | undefined;
  readonly lastToolName: string | undefined;
}

/**
 * A user turn's own prompts, its input and delivery reminders, run before queued private messages and
 * end with the turn; private messages from other sessions wait their turn and outlast an interrupted one.
 */
export type TurnKind = "user" | "private";

/** One queued turn and the caller waiting for its outcome. */
interface PendingTurn {
  readonly text: string;
  readonly kind: TurnKind;
  /** Run work in the async context the turn was submitted in, whenever the queue reaches it. */
  readonly restore: <R>(work: () => R) => R;
  readonly resolve: (outcome: TurnOutcome | undefined) => void;
  readonly reject: (error: unknown) => void;
}

/** Serializes messages to one session while allowing other sessions to run independently. */
export class SessionMailbox {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly queue: PendingTurn[] = [];
  private completion: Promise<void> = Promise.resolve();
  private draining = false;
  private paused = false;
  private phase: SessionFork["status"] = "idle";

  /** Receive a single session whose prompt calls must never overlap. */
  constructor(
    readonly session: ForkableSession,
    paused = false,
  ) {
    this.paused = paused;
    if (paused) this.phase = "stopped";
  }

  /** Include queued work in the status so callers can see a pending wakeup. */
  get status(): SessionFork["status"] {
    if (this.draining) return "running";
    if (this.queue.length > 0) return this.paused ? "queued" : "running";
    return this.phase;
  }

  // ===========================================
  // Message delivery
  // ===========================================

  /**
   * Queue a turn; a user turn's prompts take priority over pending private messages. The turn runs
   * in the async context it was submitted in, so it is traced as its sender's work rather than as
   * whatever turn was running when the queue reached it.
   */
  submit(
    text: string,
    kind: TurnKind = "private",
  ): Promise<TurnOutcome | undefined> {
    const restore = AsyncLocalStorage.snapshot();
    const result = new Promise<TurnOutcome | undefined>((resolve, reject) => {
      const turn = { text, kind, restore, resolve, reject };
      if (kind === "user") this.queue.unshift(turn);
      else this.queue.push(turn);
    });
    this.start();
    return result;
  }

  /** Allow explicitly requested work to resume after interruption. */
  resume(): void {
    this.paused = false;
    this.start();
  }

  /** Reserve queued work until the family has a free background execution slot. */
  hold(): void {
    this.paused = true;
  }

  /**
   * Stop active generation, optionally retaining private messages for the next user turn. Queued user
   * prompts, such as a delivery reminder, are always cancelled: their caller is the turn being
   * stopped, and would otherwise wait on a paused queue that only the next user turn resumes, while
   * that turn waits for this one to settle.
   */
  async stop(retainPrivate = false): Promise<void> {
    this.paused = true;
    this.clear(retainPrivate ? "user" : undefined);
    await this.session.abort();
    await this.completion;
    this.phase = "stopped";
  }

  /** Prevent later wakeups and release a session after its work has been stopped. */
  async dispose(): Promise<void> {
    this.paused = true;
    this.clear();
    await this.session.dispose();
  }

  // ===========================================
  // Turn execution
  // ===========================================

  /** Claim the drain synchronously so simultaneous senders cannot start overlapping prompts. */
  private start(): void {
    if (this.paused || this.draining || this.queue.length === 0) return;
    this.draining = true;
    this.completion = this.drain();
  }

  /** Settle each caller independently so a failed turn does not drop later messages. */
  private async drain(): Promise<void> {
    while (!this.paused && this.queue.length > 0) {
      const turn = this.queue.shift()!;
      this.phase = "running";
      try {
        await this.prompt(turn);
        this.phase = "idle";
        turn.resolve({
          text: this.session.lastResponse,
          lastToolName: this.session.lastToolName,
        });
      } catch (error) {
        this.phase = "error";
        turn.reject(error);
      }
    }
    this.draining = false;
  }

  /**
   * Prompt the session in the turn's submitted context. A private message is never part of its
   * sender's run, even when a user turn sent it, so its prompt starts a trace of its own, and
   * telemetry knows it as private rather than as its sender's message.
   */
  private prompt(turn: PendingTurn): Promise<void> {
    return turn.restore(() =>
      turn.kind === "private"
        ? context.with(withPromptSource("private", withoutRun()), () =>
            this.session.prompt(turn.text),
          )
        : this.session.prompt(turn.text),
    );
  }

  /** Resolve cancelled queued turns, of one kind or all, without running them or leaving callers waiting forever. */
  private clear(kind?: TurnKind): void {
    const kept = this.queue.filter((turn) => kind && turn.kind !== kind);
    for (const turn of this.queue.splice(0))
      if (!kept.includes(turn)) turn.resolve(undefined);
    this.queue.push(...kept);
  }
}
