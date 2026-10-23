import type { TestContext } from "node:test";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { AgentSession as PiSession } from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../../runtime/adapter/pi-agent-session.js";
import { recordWarning } from "../service/diagnostic-warnings.js";
import {
  failTelemetrySpan,
  recordTelemetryEvent,
  startTelemetrySpan,
} from "../service/telemetry-recorder.js";
import { describeError } from "../service/telemetry-redactor.js";
import { telemetryEvents } from "../model/telemetry-attributes.js";
import { sendMessageToolName } from "../../runtime/model/message-delivery.js";
import { failure, reply, settled, sse, teammate } from "./runtime-fixtures.js";

/**
 * Natural-language text an error could quote from a request, one per place error text is
 * recorded. None is a credential shape, so only withholding error text keeps it out of telemetry.
 */
export const canaries = {
  canonical: "The private launch date is next Tuesday",
  input: "Ask procurement to delay the shipment",
  compaction: "The merger closes before the board meeting",
  library: "Payroll moves to the new bank in March",
  cause: "The candidate accepted the offer yesterday",
  warning: "The keynote reveals the blue edition",
  /** Written as a category, after the words of Everything's own model-failure status. */
  lookalike: "payroll_moves_to_a_new_bank_in_march",
  /** Sent as a stream error's `error`, an array and a string rather than an object. */
  streamArray: "The roadmap slips to the spring",
  streamString: "The office closes for the summer",
} as const;

/** The status text that imitates Everything's own, carrying the lookalike canary. */
export const lookalikeStatus = `Model request failed: ${canaries.lookalike}`;

/** A tool name a model made up in the shape of a key, redacted in both modes. */
export const toolKey = "sk-proj-unknowntoolnameabcdefgh";

/** A credential inside a provider's error message, redacted whether or not error text is recorded. */
export const embeddedSecret = "sk-live-canarysecret123456";

/** Provider request IDs of the failed teammate turns; both stream failures share the last. */
export const requestIds = {
  canonical: "req_canonical_400",
  input: "req_input_400",
  stream: "req_stream_ok",
} as const;

/**
 * Record every kind of error text Everything can capture, each quoting a canary: a provider's
 * error message, a provider error body with the request's input and no message, stream errors
 * whose `error` is an array or a string, a failed context compaction, a library span's exception
 * and status, a thrown error's nested cause, status text imitating Everything's own, and an
 * installation warning's reason; and a tool call a model makes to a tool that doesn't exist, named
 * like a key. The teammate turns run on real Pi sessions with finite provider answers.
 */
export async function recordErrorText(test: TestContext): Promise<void> {
  const quoting = await teammate(test, () =>
    failure(
      400,
      {
        error: {
          message: `Rejected prompt: ${canaries.canonical} api_key=${embeddedSecret} ${"and more ".repeat(60)}`,
          type: "invalid_request_error",
        },
      },
      { "x-request-id": requestIds.canonical },
    ),
  );
  quoting.runtime.start("Hello");
  await settled(quoting.runtime);
  const echoing = await teammate(test, () =>
    failure(
      400,
      { error: { type: "invalid_request_error", input: canaries.input } },
      { "x-request-id": requestIds.input },
    ),
  );
  echoing.runtime.start("Hello");
  await settled(echoing.runtime);
  for (const error of [[canaries.streamArray], canaries.streamString]) {
    const streaming = await teammate(test, () => sse([{ error }]));
    streaming.runtime.start("Hello");
    await settled(streaming.runtime);
  }

  // Pi reports the made-up tool's call before finding no such tool, then the turn replies.
  const answers = [
    () => reply("", { name: toolKey, input: {} }),
    () =>
      reply("", {
        name: sendMessageToolName,
        input: { text: "That tool doesn’t exist." },
      }),
    () => reply("Done."),
  ];
  let answered = 0;
  const calling = await teammate(
    test,
    () =>
      answers[answered++]?.() ??
      failure(400, {
        error: { message: "No answer left", type: "invalid_request_error" },
      }),
  );
  calling.runtime.start("Hello");
  await settled(calling.runtime);

  await compactionFailure().catch(() => {});

  const owner = startTelemetrySpan("request", {
    scope: { ownerId: "owner-a" },
  });
  context.with(owner.context, () => {
    const query = trace
      .getTracer("library-instrumentation")
      .startSpan("pg.query:SELECT everything", { kind: SpanKind.CLIENT });
    query.recordException(new Error(canaries.library));
    query.setStatus({ code: SpanStatusCode.ERROR, message: canaries.library });
    query.end();
    const imitating = trace
      .getTracer("library-instrumentation")
      .startSpan("GET", { kind: SpanKind.CLIENT });
    imitating.setStatus({
      code: SpanStatusCode.ERROR,
      message: lookalikeStatus,
    });
    imitating.end();
    const lookup = startTelemetrySpan("lookup");
    failTelemetrySpan(lookup.span, new Error(lookalikeStatus));
    lookup.span.end();
    const thrown = new Error("Lookup failed", {
      cause: new Error(`Provider said: ${canaries.cause}`),
    });
    failTelemetrySpan(owner.span, thrown);
    recordTelemetryEvent({
      name: telemetryEvents.requestFailed,
      title: "Request failed",
      type: "http",
      severity: "error",
      outcome: "failure",
      httpStatus: 500,
      code: "INTERNAL_ERROR",
      error: describeError(thrown),
    });
  });
  owner.span.end();

  recordWarning("Fleet failed; Everything will retry.", {
    reason: `connect failed: ${canaries.warning}`,
  });
}

/** A main-session prompt whose context compaction fails with a provider error quoting a canary. */
async function compactionFailure(): Promise<void> {
  let listener: Parameters<PiSession["subscribe"]>[0] | undefined;
  const pi = {
    sessionId: "session-compacting",
    isCompacting: false,
    messages: [],
    subscribe(next: typeof listener) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      for (const event of [
        { type: "compaction_start", reason: "threshold" },
        {
          type: "compaction_end",
          reason: "threshold",
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage: `Summarization failed: 400 ${JSON.stringify({
            error: {
              message: `Context rejected: ${canaries.compaction}`,
              type: "invalid_request_error",
            },
          })}`,
        },
      ])
        listener?.(event as Parameters<NonNullable<typeof listener>>[0]);
    },
  };
  const session = new PiAgentSession(pi as unknown as PiSession, Date.now, {
    ownerId: "owner-a",
    agentId: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
    sessionKind: "main",
    provider: "openai-compatible",
    model: "o3-mini",
  });
  await session.prompt("Continue");
}
