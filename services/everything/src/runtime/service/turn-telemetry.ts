import {
  context,
  INVALID_SPAN_CONTEXT,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { ApplicationError } from "@everything/errors";
import {
  CompactionFailedError,
  FastModeLimitedError,
  FastModeRejectedError,
  ModelRequestFailedError,
  ReplyNotDeliveredError,
} from "../error/runtime-errors.js";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
  telemetrySpans,
} from "../../telemetry/model/telemetry-attributes.js";
import type { TelemetryScope } from "../../telemetry/model/telemetry-scope.js";
import {
  failTelemetrySpan,
  recordTelemetryEvent,
  startTelemetrySpan,
} from "../../telemetry/service/telemetry-recorder.js";
import { describeError } from "../../telemetry/service/telemetry-redactor.js";
import { messagePreview } from "../../telemetry/service/message-preview.js";

/** Why a running turn ended early: the owner pressed Stop, sent a new message, or the runtime closed. */
export type TurnCancellation = "stopped" | "interrupted" | "closed";

/** Safe codes for the ways a turn fails, by the error that ended it. */
const failureCodes: readonly [new (...args: never[]) => Error, string][] = [
  [FastModeRejectedError, "FAST_MODE_REJECTED"],
  [FastModeLimitedError, "FAST_MODE_LIMITED"],
  [ModelRequestFailedError, "MODEL_REQUEST_FAILED"],
  [CompactionFailedError, "COMPACTION_FAILED"],
  [ReplyNotDeliveredError, "REPLY_NOT_DELIVERED"],
];

/**
 * Telemetry for one turn of a teammate's main conversation: a span starting a trace of its own,
 * linked to the request that started it, under which the turn's prompts, provider requests, tool
 * calls, and compactions are recorded, and an event when the turn fails or is stopped. The span
 * holds a bounded, redacted preview of the message the turn answers: the text sent to the
 * teammate's conversation, never the reminders, private messages, or instructions Everything adds
 * to the session, and never the model's thinking.
 */
export class TurnTelemetry {
  // ===========================================
  // State and construction
  // ===========================================

  /** The context the turn's work runs in. */
  readonly context: Context;
  private readonly span: Span;

  /**
   * Start the turn's span for the session's run, attributing it to `scope` when known, with a
   * preview of `message`, the text sent to the conversation that the turn answers.
   */
  constructor(
    scope: TelemetryScope | undefined,
    sessionId: string,
    runId: string,
    message?: string,
  ) {
    let started: { span: Span; context: Context };
    try {
      // The request that started the turn can then be found by the turn's run ID.
      trace.getActiveSpan()?.setAttribute(attribute.runId, runId);
      started = startTelemetrySpan(telemetrySpans.turn, {
        root: true,
        ...(scope
          ? { scope: { ...scope, sessionId, sessionKind: "main", runId } }
          : {}),
        attributes: {
          [attribute.type]: "turn",
          [attribute.sessionId]: sessionId,
          [attribute.runId]: runId,
          ...(message !== undefined ? previewAttributes(message) : {}),
        },
      });
    } catch {
      // Telemetry never stops a turn; this one runs unrecorded.
      started = {
        span: trace.wrapSpanContext(INVALID_SPAN_CONTEXT),
        context: context.active(),
      };
    }
    this.span = started.span;
    this.context = started.context;
  }

  // ===========================================
  // Outcomes
  // ===========================================

  /** The turn settled without an error, possibly because it was stopped. */
  completed(cancellation?: TurnCancellation): void {
    try {
      if (cancellation) this.cancelled(cancellation);
      this.span.end();
    } catch {
      // Recording never changes the turn's outcome.
    }
  }

  /** The turn ended in an error, which counts as a cancellation if the turn was being stopped. */
  failed(error: unknown, cancellation?: TurnCancellation): void {
    try {
      this.recordFailure(error, cancellation);
    } catch {
      // Recording never changes the turn's outcome.
    }
  }

  /** Record the failure, or the cancellation it turned out to be, and end the span. */
  private recordFailure(error: unknown, cancellation?: TurnCancellation): void {
    if (cancellation) this.cancelled(cancellation);
    else {
      failTelemetrySpan(this.span, error);
      const code =
        failureCodes.find(([type]) => error instanceof type)?.[1] ??
        (error instanceof ApplicationError ? error.code : "TURN_FAILED");
      const unexpected = code === "TURN_FAILED";
      recordTelemetryEvent(
        {
          name: telemetryEvents.turnFailed,
          title: "Teammate turn failed",
          type: "turn",
          severity: "error",
          outcome: "failure",
          code,
          ...(unexpected ? { error: describeError(error) } : {}),
        },
        this.context,
      );
    }
    this.span.end();
  }

  /** Record a stopped turn as cancelled rather than failed. */
  private cancelled(cancellation: TurnCancellation): void {
    failTelemetrySpan(this.span, undefined, "cancelled");
    recordTelemetryEvent(
      {
        name: telemetryEvents.turnCancelled,
        title: "Teammate turn stopped",
        type: "turn",
        severity: "info",
        outcome: "cancelled",
        attributes: { [attribute.reason]: cancellation },
      },
      this.context,
    );
  }
}

/** A message's preview as span attributes, or none when it can't be made. */
function previewAttributes(message: string): Attributes {
  try {
    const preview = messagePreview(message);
    return {
      [attribute.messagePreview]: preview.text,
      [attribute.messageLength]: preview.length,
      [attribute.messageTruncated]: preview.truncated,
    };
  } catch {
    // A preview never stops a turn; this one is recorded without it.
    return {};
  }
}
