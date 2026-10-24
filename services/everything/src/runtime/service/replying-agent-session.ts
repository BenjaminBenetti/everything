import { context } from "@opentelemetry/api";
import type { AgentSession } from "../interface/agent-session.js";
import { withPromptSource } from "../../telemetry/service/telemetry-recorder.js";
import {
  outcomeDeliveryPrompt,
  replyDeliveryPrompt,
} from "../prompt/reply-delivery-prompt.js";
import { sendMessageToolName } from "../model/message-delivery.js";
import { ReplyNotDeliveredError } from "../error/runtime-errors.js";

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

  /** Preserve the active summary's start time through reply-delivery correction. */
  get compactionStartedAt(): string | null {
    return this.session.compactionStartedAt;
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
   * reminder to report the outcome. Telemetry is told which prompt is the user's message and which
   * are reminders, never what either says.
   */
  async prompt(text: string): Promise<void> {
    this.stopped = false;
    const before = this.deliveredCount();
    await this.promptFrom("message", text);
    if (this.stopped) return;
    if (this.deliveredCount() === before) {
      await this.promptFrom("reminder", replyDeliveryPrompt);
      if (!this.stopped && this.deliveredCount() === before)
        throw new ReplyNotDeliveredError();
    } else if (this.session.lastToolName !== sendMessageToolName)
      await this.promptFrom("reminder", outcomeDeliveryPrompt);
  }

  /** Prompt the session with `text`, which comes from `source`. */
  private promptFrom(
    source: "message" | "reminder",
    text: string,
  ): Promise<void> {
    return context.with(withPromptSource(source), () =>
      this.session.prompt(text),
    );
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
