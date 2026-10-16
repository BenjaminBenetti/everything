import type { AgentSession } from "../interface/agent-session.js";
import {
  outcomeDeliveryPrompt,
  replyDeliveryPrompt,
} from "../prompt/reply-delivery-prompt.js";
import { sendMessageToolName } from "../model/message-delivery.js";

/** Require deliberate delivery for user turns without treating private model text as a reply. */
export class ReplyingAgentSession implements AgentSession {
  // ===========================================
  // State and construction
  // ===========================================

  private stopped = false;

  /** Observe committed deliveries separately from the provider's private response stream. */
  constructor(
    private readonly session: AgentSession,
    private readonly deliveredCount: () => number,
  ) {}

  // ===========================================
  // Session state
  // ===========================================

  /** Preserve the underlying durable session identity. */
  get id(): string {
    return this.session.id;
  }

  /** Forward summarization progress during the original turn or its delivery reminder. */
  get compacting(): boolean {
    return this.session.compacting;
  }

  /** Forward the tool the latest prompt, or its reminder, finished last. */
  get lastToolName(): string | undefined {
    return this.session.lastToolName;
  }

  /** Forward whether a message to the user is being written, including during a reminder. */
  get typing(): boolean {
    return this.session.typing;
  }

  /** Preserve background activity so the runtime can report and stop the whole teammate. */
  get background(): AgentSession["background"] {
    return this.session.background;
  }

  /** Preserve the same private family when user-turn delivery is decorated. */
  get subagents(): AgentSession["subagents"] {
    return this.session.subagents;
  }

  // ===========================================
  // User turns
  // ===========================================

  /**
   * Give an undelivered answer one corrective turn, then fail instead of silently completing. A turn
   * that replied early, such as confirming a task, but kept working after its last message gets one
   * reminder to report the outcome.
   */
  async prompt(text: string): Promise<void> {
    this.stopped = false;
    const before = this.deliveredCount();
    await this.session.prompt(text);
    if (this.stopped) return;
    if (this.deliveredCount() === before) {
      await this.session.prompt(replyDeliveryPrompt);
      if (!this.stopped && this.deliveredCount() === before)
        throw new Error("The teammate did not deliver a reply");
    } else if (this.session.lastToolName !== sendMessageToolName)
      await this.session.prompt(outcomeDeliveryPrompt);
  }

  /** Stop delivery correction and pass through whether the caller also cancelled background work. */
  async abort(scope: "turn" | "all" = "all"): Promise<void> {
    this.stopped = true;
    await this.session.abort(scope);
  }

  /** Release the underlying session after its current turn has settled. */
  dispose(): Promise<void> {
    return this.session.dispose();
  }
}
