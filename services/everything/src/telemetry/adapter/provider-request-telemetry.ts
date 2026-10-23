import { setTimeout as delay } from "node:timers/promises";
import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ProviderResponseRecord } from "../model/model-failure.js";
import {
  telemetryAttributes as attribute,
  telemetrySpans,
} from "../model/telemetry-attributes.js";
import type { TelemetryScope } from "../model/telemetry-scope.js";
import { providerErrorBody } from "../service/model-failure-classifier.js";
import {
  promptDiagnostics,
  type ProviderAttempt,
} from "../service/prompt-diagnostics.js";
import {
  failTelemetrySpan,
  startTelemetrySpan,
} from "../service/telemetry-recorder.js";
import {
  redactPath,
  redactText,
  safeIdentifier,
} from "../service/telemetry-redactor.js";

/** Response headers providers return their request IDs in. */
const requestIdHeaders = [
  "request-id",
  "x-request-id",
  "anthropic-request-id",
  "openai-request-id",
] as const;

/** Most of an error response read to find its code and message. */
const errorBodyLimit = 16 * 1024;

/** Longest wait for an error response's body; the SDK still reads its own copy. */
const errorBodyTimeoutMs = 2_000;

/** Longest provider error excerpt kept on a span. */
const errorMessageLimit = 300;

/**
 * Time each HTTP attempt of a model request as a `provider.request` span, recording its status,
 * the provider's request ID, a `Retry-After` value, and, for an error response, the provider's
 * error code and a redacted excerpt of its error message, which is exported only if the
 * installation records error text. Request and response contents are not recorded. The enclosing
 * prompt's diagnostics receive each response, so a failure that ends the prompt later can be
 * explained. The response passed back is unchanged and unread.
 */
export function observeProviderRequests(
  fetcher: typeof fetch,
  scope: TelemetryScope,
): typeof fetch {
  return async (input, init) => {
    let started: ReturnType<typeof startTelemetrySpan>;
    let diagnostics: ReturnType<typeof promptDiagnostics>;
    let attempt: ProviderAttempt | undefined;
    try {
      diagnostics = promptDiagnostics();
      attempt = diagnostics?.nextAttempt();
      started = startTelemetrySpan(telemetrySpans.providerRequest, {
        kind: SpanKind.CLIENT,
        scope,
        attributes: {
          [attribute.type]: "model",
          [attribute.attempt]: attempt?.number ?? 1,
          ...(requestTarget(input) ?? {}),
        },
      });
    } catch {
      // Telemetry never stops a provider request; this one goes untimed.
      return fetcher(input, init);
    }
    const { span, context: spanContext } = started;
    let response: Response;
    try {
      response = await context.with(spanContext, () => fetcher(input, init));
    } catch (error) {
      const aborted =
        init?.signal?.aborted === true ||
        (error instanceof Error && error.name === "AbortError");
      failTelemetrySpan(span, error, aborted ? "cancelled" : "failure");
      span.end();
      throw error;
    }
    try {
      const record = await responseRecord(response, attempt?.number ?? 1);
      span.setAttributes({
        [attribute.httpStatus]: record.status,
        ...(record.requestId
          ? { [attribute.requestId]: record.requestId }
          : {}),
        ...(record.retryAfter
          ? { [attribute.retryAfter]: record.retryAfter }
          : {}),
        ...(record.errorType ? { [attribute.code]: record.errorType } : {}),
        // Error text, exported only if the installation records it.
        ...(record.errorMessage
          ? { [attribute.message]: record.errorMessage }
          : {}),
      });
      if (!response.ok)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${record.status}`,
        });
      if (attempt) diagnostics?.record(attempt, record);
    } catch {
      // Recording never changes the response the SDK receives.
    } finally {
      span.end();
    }
    return response;
  };
}

/** The request's host and path, without credentials or query string. */
function requestTarget(
  input: Parameters<typeof fetch>[0],
): Record<string, string> | undefined {
  try {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    return {
      [attribute.serverAddress]: url.host,
      [attribute.urlPath]: redactPath(url.pathname),
    };
  } catch {
    return undefined;
  }
}

/**
 * A response's status and headers, and for an error its provider code and an excerpt of its error
 * message only; the body's other fields are not kept.
 */
async function responseRecord(
  response: Response,
  attempt: number,
): Promise<ProviderResponseRecord> {
  const requestId = requestIdHeaders
    .map((name) => safeIdentifier(response.headers.get(name)))
    .find((value) => value !== undefined);
  const retryAfter = response.headers.get("retry-after");
  const base = {
    attempt,
    status: response.status,
    ...(requestId ? { requestId } : {}),
    ...(retryAfter && /^[\w :,+-]{1,64}$/.test(retryAfter)
      ? { retryAfter }
      : {}),
  };
  if (response.ok) return base;
  const body = providerErrorBody(await boundedText(response));
  const errorType = safeIdentifier(body.code, 64);
  return {
    ...base,
    ...(errorType ? { errorType } : {}),
    ...(body.message
      ? { errorMessage: redactText(body.message, errorMessageLimit) }
      : {}),
    ...(!requestId && safeIdentifier(body.requestId)
      ? { requestId: safeIdentifier(body.requestId)! }
      : {}),
  };
}

/** The start of a copy of the response's body, leaving the original for the SDK. */
async function boundedText(response: Response): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    const deadline = Date.now() + errorBodyTimeoutMs;
    while (size < errorBodyLimit && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        delay(Math.max(0, deadline - Date.now()), undefined, { ref: false }),
      ]);
      if (!next || next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
    return new TextDecoder()
      .decode(Buffer.concat(chunks))
      .slice(0, errorBodyLimit);
  } catch {
    return "";
  } finally {
    void reader?.cancel().catch(() => {});
  }
}
