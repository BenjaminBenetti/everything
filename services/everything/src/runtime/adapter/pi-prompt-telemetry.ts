import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import type { AgentSession as PiSession } from "@earendil-works/pi-coding-agent";
import { speedReport } from "../model/speed-report.js";
import { classifyModelFailure } from "../../telemetry/service/model-failure-classifier.js";
import {
  PromptDiagnostics,
  withPromptDiagnostics,
} from "../../telemetry/service/prompt-diagnostics.js";
import {
  failTelemetrySpan,
  recordTelemetryEvent,
  startTelemetrySpan,
  telemetryScope,
} from "../../telemetry/service/telemetry-recorder.js";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
  telemetrySpans,
} from "../../telemetry/model/telemetry-attributes.js";
import type { TelemetryScope } from "../../telemetry/model/telemetry-scope.js";
import { telemetryStatuses } from "../../telemetry/model/telemetry-statuses.js";
import { safeIdentifier } from "../../telemetry/service/telemetry-redactor.js";
import { toolArgumentsPreview } from "../../telemetry/service/tool-arguments-preview.js";

/** An event a Pi session reports while it works. */
type PiSessionEvent = Parameters<Parameters<PiSession["subscribe"]>[0]>[0];

/** A message Pi records, of which only assistant responses are inspected. */
type PiMessage = PiSession["messages"][number];

/** Who a session belongs to; its own ID is added when it is known. */
export type PromptTelemetryScope = TelemetryScope & {
  readonly sessionKind: "main" | "fork";
};

/** One running prompt's span, diagnostics, and open child spans. */
interface RunningPrompt {
  readonly span: Span;
  readonly context: Context;
  readonly diagnostics: PromptDiagnostics;
  readonly tools: Map<string, Span>;
  compaction: Span | undefined;
  readonly recorded: WeakSet<object>;
  /** A failed response has been diagnosed, and the span's status names its category. */
  diagnosed: boolean;
}

/**
 * Telemetry for one Pi session's prompts: a span per prompt, with child spans for tool calls and
 * context compaction, and durable events for model and compaction failures captured from Pi's own
 * messages before the session reduces them to a generic error. A tool call's span holds a bounded,
 * redacted preview of its arguments, read without changing them; prompts, the session's context,
 * responses, thinking, and tool results are not recorded. A failure's error text, which can quote
 * what was sent, and argument previews are exported only if the installation records them.
 */
export class PiPromptTelemetry {
  // ===========================================
  // State and construction
  // ===========================================

  private running: RunningPrompt | undefined;

  /** Record for the session `sessionId`, which belongs to `scope`. */
  constructor(
    private readonly scope: PromptTelemetryScope,
    private readonly sessionId: string,
  ) {}

  // ===========================================
  // Prompts
  // ===========================================

  /**
   * Run one prompt inside its span. A main-session prompt during the teammate's user turn joins the
   * turn's trace; other prompts, such as a background fork's, start a trace of their own linked to
   * what woke them.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    let prompt: RunningPrompt;
    try {
      prompt = this.begin();
    } catch {
      // Telemetry never stops a prompt; this one runs unrecorded.
      return work();
    }
    this.running = prompt;
    try {
      return await context.with(
        withPromptDiagnostics(prompt.diagnostics, prompt.context),
        work,
      );
    } catch (error) {
      // The diagnosed failure's status explains the prompt better than the error reporting it.
      if (!prompt.diagnosed)
        failTelemetrySpan(
          prompt.span,
          error,
          error instanceof Error && error.name === "AbortError"
            ? "cancelled"
            : "failure",
        );
      throw error;
    } finally {
      try {
        for (const tool of prompt.tools.values()) tool.end();
        prompt.compaction?.end();
        prompt.span.end();
      } catch {
        // Ending spans never changes the prompt's outcome.
      }
      if (this.running === prompt) this.running = undefined;
    }
  }

  /** Start the prompt's span and diagnostics. */
  private begin(): RunningPrompt {
    const enclosing = telemetryScope();
    const partOfTurn =
      this.scope.sessionKind === "main" &&
      enclosing?.ownerId === this.scope.ownerId &&
      enclosing.sessionId === this.sessionId &&
      !!enclosing.runId;
    const { span, context: promptContext } = startTelemetrySpan(
      telemetrySpans.prompt,
      {
        root: !partOfTurn,
        scope: { ...this.scope, sessionId: this.sessionId },
        attributes: { [attribute.type]: "turn" },
      },
    );
    return {
      span,
      context: promptContext,
      diagnostics: new PromptDiagnostics(),
      tools: new Map(),
      compaction: undefined,
      recorded: new WeakSet(),
      diagnosed: false,
    };
  }

  /** Record a final failed or cancelled response the session events did not already report. */
  settle(message: PiMessage | undefined): void {
    const prompt = this.running;
    try {
      if (prompt && message) this.recordResponse(prompt, message);
    } catch {
      // Recording never changes how the session reports the failure.
    }
  }

  // ===========================================
  // Session events
  // ===========================================

  /** Follow tool calls, compaction, retries, and responses while a prompt runs. */
  observe(event: PiSessionEvent): void {
    const prompt = this.running;
    if (!prompt) return;
    try {
      switch (event.type) {
        case "tool_execution_start":
          prompt.tools.get(event.toolCallId)?.end();
          prompt.tools.set(
            event.toolCallId,
            startTelemetrySpan(
              telemetrySpans.tool,
              {
                attributes: {
                  [attribute.type]: "tool",
                  // The model names the tool, so only a well-formed name is kept.
                  [attribute.tool]:
                    safeIdentifier(event.toolName, 128) ?? "unknown",
                  ...argumentAttributes(event.args),
                },
              },
              prompt.context,
            ).span,
          );
          break;
        case "tool_execution_end": {
          const tool = prompt.tools.get(event.toolCallId);
          prompt.tools.delete(event.toolCallId);
          if (tool && event.isError) {
            tool.setAttribute(attribute.outcome, "failure");
            tool.setStatus({ code: SpanStatusCode.ERROR });
          }
          tool?.end();
          break;
        }
        case "compaction_start":
          prompt.compaction?.end();
          prompt.compaction = startTelemetrySpan(
            telemetrySpans.compaction,
            {
              attributes: {
                [attribute.type]: "turn",
                [attribute.reason]: event.reason,
              },
            },
            prompt.context,
          ).span;
          break;
        case "compaction_end":
          this.endCompaction(prompt, event);
          break;
        case "summarization_retry_scheduled":
          (prompt.compaction ?? prompt.span).addEvent("summarization.retry", {
            [attribute.attempt]: event.attempt,
            [attribute.attempts]: event.maxAttempts,
          });
          break;
        case "auto_retry_start":
          prompt.span.addEvent("retry.scheduled", {
            [attribute.attempt]: event.attempt,
            [attribute.attempts]: event.maxAttempts,
          });
          break;
        case "message_end":
          this.recordResponse(prompt, event.message);
          break;
      }
    } catch {
      // Observing never interferes with the session.
    }
  }

  // ===========================================
  // Recording
  // ===========================================

  /** End the compaction span and record a failed or cancelled compaction. */
  private endCompaction(
    prompt: RunningPrompt,
    event: Extract<PiSessionEvent, { type: "compaction_end" }>,
  ): void {
    const span = prompt.compaction;
    prompt.compaction = undefined;
    const attributes = {
      [attribute.reason]: event.reason,
      [attribute.willRetry]: event.willRetry,
    };
    if (event.aborted) {
      span?.setAttribute(attribute.outcome, "cancelled");
      recordTelemetryEvent(
        {
          name: telemetryEvents.compactionCancelled,
          title: "Context compaction stopped",
          type: "turn",
          severity: "info",
          outcome: "cancelled",
          attributes,
        },
        span ? withSpan(prompt.context, span) : prompt.context,
      );
    } else if (event.errorMessage) {
      const failure = classifyModelFailure({
        stopReason: "error",
        errorMessage: event.errorMessage,
      });
      span?.setStatus({
        code: SpanStatusCode.ERROR,
        message: telemetryStatuses.compactionFailed,
      });
      span?.setAttribute(attribute.outcome, "failure");
      // Error text, exported only if the installation records it.
      if (failure.message)
        span?.setAttribute(attribute.message, failure.message);
      recordTelemetryEvent(
        {
          name: telemetryEvents.compactionFailed,
          title: "Context compaction failed",
          type: "turn",
          severity: "error",
          outcome: "failure",
          category: failure.category,
          ...(failure.code ? { code: failure.code } : {}),
          ...(failure.httpStatus !== undefined
            ? { httpStatus: failure.httpStatus }
            : {}),
          ...(failure.message ? { message: failure.message } : {}),
          attributes,
        },
        span ? withSpan(prompt.context, span) : prompt.context,
      );
    }
    span?.end();
  }

  /** Record a model response that ended in an error or was cancelled, once. */
  private recordResponse(prompt: RunningPrompt, message: PiMessage): void {
    if (
      message.role !== "assistant" ||
      (message.stopReason !== "error" && message.stopReason !== "aborted") ||
      prompt.recorded.has(message)
    )
      return;
    prompt.recorded.add(message);
    const speed = speedReport(message);
    const failure = classifyModelFailure({
      stopReason: message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      ...(prompt.diagnostics.lastResponse
        ? { lastResponse: prompt.diagnostics.lastResponse }
        : {}),
      ...(speed?.failure ? { speedFailure: speed.failure } : {}),
    });
    const cancelled = failure.category === "cancelled";
    if (!cancelled) {
      prompt.diagnosed = true;
      prompt.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: telemetryStatuses.modelFailed(failure.category),
      });
    }
    recordTelemetryEvent(
      {
        name: cancelled
          ? telemetryEvents.modelCancelled
          : telemetryEvents.modelFailed,
        title: cancelled ? "Model request stopped" : "Model request failed",
        type: "model",
        severity: cancelled ? "info" : "error",
        outcome: cancelled ? "cancelled" : "failure",
        category: failure.category,
        retryable: failure.retryable,
        ...(failure.code ? { code: failure.code } : {}),
        ...(failure.message ? { message: failure.message } : {}),
        ...(failure.httpStatus !== undefined
          ? { httpStatus: failure.httpStatus }
          : {}),
        ...(failure.requestId ? { requestId: failure.requestId } : {}),
        attributes: {
          [attribute.api]: message.api,
          [attribute.stopReason]: message.stopReason,
          [attribute.attempts]: prompt.diagnostics.attempts,
          ...(speed ? { [attribute.speed]: speed.requested } : {}),
          ...(prompt.diagnostics.lastResponse?.retryAfter
            ? {
                [attribute.retryAfter]:
                  prompt.diagnostics.lastResponse.retryAfter,
              }
            : {}),
        },
      },
      prompt.context,
    );
  }
}

/** A context whose active span is `span`, keeping the prompt's scope. */
function withSpan(current: Context, span: Span): Context {
  return trace.setSpan(current, span);
}

/**
 * A tool call's arguments as span attributes: a bounded, redacted preview built without changing
 * them, since the same object is what the tool runs with.
 */
function argumentAttributes(args: unknown): Attributes {
  const preview = toolArgumentsPreview(args);
  return {
    [attribute.toolArguments]: preview.text,
    [attribute.toolArgumentsTruncated]: preview.truncated,
  };
}
