import type { AgentSession as PiSession } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "../interface/agent-session.js";

/** Adapts a native Pi session to the application's runtime contract. */
export class PiAgentSession implements AgentSession {
  // ===========================================
  // State
  // ===========================================

  readonly id: string;

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

  /** Run Pi and surface provider failures instead of reporting a successful empty turn. */
  async prompt(text: string): Promise<void> {
    await this.session.prompt(text);
    const last = this.session.messages.at(-1);
    if (last?.role === "assistant" && last.stopReason === "error")
      throw new Error("Pi model request failed");
  }

  /** Abort generation and await in-flight tools. */
  async abort(): Promise<void> {
    await this.session.abort();
  }

  /** Release Pi listeners and resources. */
  dispose(): void {
    this.session.dispose();
  }
}
