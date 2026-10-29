import type { AgentSession as PiSession } from "@earendil-works/pi-coding-agent";
import type { ForkableSession } from "../interface/session-forks.js";
import { sendMessageToolName } from "../model/message-delivery.js";
import { speedReport } from "../model/speed-report.js";
import {
  CompactionFailedError,
  FastModeLimitedError,
  FastModeRejectedError,
  ModelRequestFailedError,
} from "../error/runtime-errors.js";
import {
  PiPromptTelemetry,
  type PromptTelemetryScope,
} from "./pi-prompt-telemetry.js";

/** An event a Pi session reports while it works. */
type PiSessionEvent = Parameters<Parameters<PiSession["subscribe"]>[0]>[0];

/** Adapts a native Pi session to the application's runtime contract. */
export class PiAgentSession implements ForkableSession {
  // ===========================================
  // State
  // ===========================================

  readonly id: string;
  private cancellation: AbortController | undefined;
  private lastTool: string | undefined;
  private writing = false;
  private compactionStart: string | null = null;
  private readonly telemetry: PiPromptTelemetry | undefined;

  // ===========================================
  // Construction
  // ===========================================

  /**
   * Wrap a created Pi session with a clock for server-owned activity timestamps and, when it belongs
   * to a known owner and teammate, telemetry for its prompts.
   */
  constructor(
    private readonly session: PiSession,
    private readonly now: () => number = Date.now,
    telemetry?: PromptTelemetryScope,
  ) {
    this.id = session.sessionId;
    this.telemetry = telemetry && new PiPromptTelemetry(telemetry, this.id);
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Read compaction state without exposing summaries or the private transcript. */
  get compacting(): boolean {
    return this.session.isCompacting;
  }

  /** Keep the same start time throughout an active summary, independently of status polling. */
  get compactionStartedAt(): string | null {
    return this.compactionStart;
  }

  /** The tool the latest prompt finished last, in completion order. */
  get lastToolName(): string | undefined {
    return this.lastTool;
  }

  /** Whether the model is writing a message to the user, until that message is delivered. */
  get typing(): boolean {
    return this.writing;
  }

  /** Return private final text only to the owning background-session coordinator. */
  get lastResponse(): string | undefined {
    return this.session.getLastAssistantText();
  }

  /**
   * Run through compaction/recovery and surface safe failures, including swallowed summary errors and
   * refused Fast mode requests.
   */
  async prompt(text: string): Promise<void> {
    if (this.telemetry) return this.telemetry.run(() => this.run(text));
    return this.run(text);
  }

  /** Prompt the native session once, converting its failures for the caller. */
  private async run(text: string): Promise<void> {
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    this.lastTool = undefined;
    this.writing = false;
    let compactionFailed = false;
    const unsubscribe = this.session.subscribe((event) => {
      this.telemetry?.observe(event);
      if (event.type === "compaction_start")
        this.compactionStart = new Date(this.now()).toISOString();
      if (event.type === "compaction_end") {
        this.compactionStart = null;
        if (event.errorMessage) compactionFailed = true;
      }
      if (event.type === "tool_execution_end") this.lastTool = event.toolName;
      this.followTyping(event);
    });
    try {
      await this.session.prompt(text, {
        expandPromptTemplates: false,
        /** Stop a cancelled or failed pre-prompt compaction before Pi can begin another request. */
        preflightResult: () => {
          cancellation.signal.throwIfAborted();
          if (compactionFailed) throw new CompactionFailedError();
        },
      });
      if (compactionFailed) throw new CompactionFailedError();
      const last = this.session.messages.at(-1);
      // Telemetry records the provider's failure here, before it becomes the generic error below.
      this.telemetry?.settle(last);
      if (last?.role === "assistant" && last.stopReason === "error") {
        // A refused Fast request ends the turn with its own recovery; it never retries at standard speed.
        const failure = speedReport(last)?.failure;
        if (failure === "rejected") throw new FastModeRejectedError();
        if (failure === "limited") throw new FastModeLimitedError();
        throw new ModelRequestFailedError();
      }
    } finally {
      unsubscribe();
      this.cancellation = undefined;
      this.writing = false;
      this.compactionStart = null;
    }
  }

  /** Abort generation and await in-flight tools. */
  async abort(): Promise<void> {
    this.cancellation?.abort();
    await this.session.abort();
  }

  /**
   * End the session for its extensions, which closes its MCP connections, then release Pi's
   * listeners and resources. Pi's own dispose does not notify extensions.
   */
  async dispose(): Promise<void> {
    try {
      const extensions = this.session.extensionRunner;
      if (extensions.hasHandlers("session_shutdown"))
        await extensions.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      this.session.dispose();
    }
  }

  // ===========================================
  // Typing
  // ===========================================

  /**
   * Follow a message to the user from the first streamed part of its send_message call until the
   * call delivers it. Other output, a response that calls no tools, or a failed call ends it.
   */
  private followTyping(event: PiSessionEvent): void {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (
        update.type === "toolcall_start" ||
        update.type === "toolcall_delta"
      ) {
        // Some providers name the tool only in a later part of the call.
        const block = update.partial.content[update.contentIndex];
        this.writing =
          block?.type === "toolCall" && block.name === sendMessageToolName;
      } else if (
        update.type === "text_start" ||
        update.type === "thinking_start"
      )
        this.writing = false;
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason !== "toolUse"
    )
      this.writing = false;
    else if (
      event.type === "tool_execution_end" &&
      event.toolName === sendMessageToolName
    )
      this.writing = false;
  }
}
