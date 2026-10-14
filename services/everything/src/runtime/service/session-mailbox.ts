import type {
  ForkableSession,
  SessionFork,
} from "../interface/session-forks.js";

/** Capture the completed turn before another queued message changes the live session state. */
interface TurnOutcome {
  readonly text: string | undefined;
  readonly lastToolName: string | undefined;
}

/** One queued turn and the caller waiting for its outcome. */
interface PendingTurn {
  readonly text: string;
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

  /** Queue a turn; user input can take priority over pending private messages. */
  submit(text: string, first = false): Promise<TurnOutcome | undefined> {
    const result = new Promise<TurnOutcome | undefined>((resolve, reject) => {
      const turn = { text, resolve, reject };
      if (first) this.queue.unshift(turn);
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

  /** Stop active generation, optionally retaining private messages for the next user turn. */
  async stop(retainQueue = false): Promise<void> {
    this.paused = true;
    if (!retainQueue) this.clear();
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
        await this.session.prompt(turn.text);
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

  /** Resolve cancelled queued turns without running them or leaving callers waiting forever. */
  private clear(): void {
    for (const turn of this.queue.splice(0)) turn.resolve(undefined);
  }
}
