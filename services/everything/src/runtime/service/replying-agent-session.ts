import type { AgentSession } from "../interface/agent-session.js";
import { replyDeliveryPrompt } from "../prompt/reply-delivery-prompt.js";

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

  // ===========================================
  // User turns
  // ===========================================

  /** Give an undelivered answer one corrective turn, then fail instead of silently completing. */
  async prompt(text: string): Promise<void> {
    this.stopped = false;
    const before = this.deliveredCount();
    await this.session.prompt(text);
    if (this.stopped || this.deliveredCount() > before) return;
    await this.session.prompt(replyDeliveryPrompt);
    if (!this.stopped && this.deliveredCount() === before)
      throw new Error("The teammate did not deliver a reply");
  }

  /** Stop both ordinary generation and any pending delivery correction. */
  async abort(): Promise<void> {
    this.stopped = true;
    await this.session.abort();
  }

  /** Release the underlying session after its current turn has settled. */
  dispose(): void {
    this.session.dispose();
  }
}
