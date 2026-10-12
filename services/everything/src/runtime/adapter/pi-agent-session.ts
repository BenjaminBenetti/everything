import type { AgentSession as PiSession } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "../interface/agent-session.js";

/** Adapts a native Pi session to the application's runtime contract. */
export class PiAgentSession implements AgentSession {
  // ===========================================
  // State
  // ===========================================

  readonly id: string;
  private cancellation: AbortController | undefined;

  // ===========================================
  // Construction
  // ===========================================

  /** Wrap a created Pi session, recording the session ID it was opened with. */
  constructor(private readonly session: PiSession) {
    this.id = session.sessionId;
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Read compaction state without exposing summaries or the private transcript. */
  get compacting(): boolean {
    return this.session.isCompacting;
  }

  /** Run through compaction/recovery and surface safe failures, including swallowed summary errors. */
  async prompt(text: string): Promise<void> {
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    let compactionFailed = false;
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "compaction_end" && event.errorMessage)
        compactionFailed = true;
    });
    try {
      await this.session.prompt(text, {
        expandPromptTemplates: false,
        /** Stop a cancelled or failed pre-prompt compaction before Pi can begin another request. */
        preflightResult: () => {
          cancellation.signal.throwIfAborted();
          if (compactionFailed) throw new Error("Pi context compaction failed");
        },
      });
      if (compactionFailed) throw new Error("Pi context compaction failed");
      const last = this.session.messages.at(-1);
      if (last?.role === "assistant" && last.stopReason === "error")
        throw new Error("Pi model request failed");
    } finally {
      unsubscribe();
      this.cancellation = undefined;
    }
  }

  /** Abort generation and await in-flight tools. */
  async abort(): Promise<void> {
    this.cancellation?.abort();
    await this.session.abort();
  }

  /** Release Pi listeners and resources. */
  dispose(): void {
    this.session.dispose();
  }
}
