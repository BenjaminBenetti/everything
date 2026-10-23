import type {
  ModelFailure,
  ModelFailureCategory,
  ModelFailureInput,
} from "../model/model-failure.js";
import { redactText, safeIdentifier } from "./telemetry-redactor.js";

/** Longest excerpt of a provider's explanation kept with a failure. */
export const modelFailureMessageLimit = 300;

/** Most of an explanation matched against wording. */
const classificationLimit = 4_096;

/** Provider error types and codes, from Anthropic's and OpenAI's APIs, by category. */
const providerCodes: Readonly<Record<string, ModelFailureCategory>> = {
  rate_limit_error: "rate_limit",
  rate_limit_exceeded: "rate_limit",
  insufficient_quota: "quota",
  billing_error: "quota",
  overloaded_error: "overloaded",
  api_error: "server_error",
  server_error: "server_error",
  timeout_error: "timeout",
  authentication_error: "authentication",
  invalid_api_key: "authentication",
  permission_error: "permission",
  not_found_error: "not_found",
  model_not_found: "not_found",
  request_too_large: "request_too_large",
  context_length_exceeded: "context_length",
  invalid_request_error: "invalid_request",
  content_filter: "content_filter",
};

/** HTTP statuses by category, when the provider's own code says nothing more specific. */
const statusCategories: Readonly<Record<number, ModelFailureCategory>> = {
  400: "invalid_request",
  401: "authentication",
  403: "permission",
  404: "not_found",
  408: "timeout",
  413: "request_too_large",
  422: "invalid_request",
  429: "rate_limit",
  500: "server_error",
  502: "unavailable",
  503: "unavailable",
  504: "timeout",
  529: "overloaded",
};

/** Message wording, tried in order, for failures without a usable status or code. */
const messageCategories: readonly [RegExp, ModelFailureCategory][] = [
  [
    /credit balance|insufficient.quota|billing|exceeded your current quota/i,
    "quota",
  ],
  [
    /context.?(length|window)|maximum context|prompt is too long|input is too long|too many (input )?tokens/i,
    "context_length",
  ],
  [/overloaded/i, "overloaded"],
  [/rate.?limit/i, "rate_limit"],
  [/timed? ?out|timeout|deadline/i, "timeout"],
  [
    /ended without a stop reason|stream (was )?(interrupted|closed)|premature close|unexpected end|terminated|incomplete (response|stream)/i,
    "stream_interrupted",
  ],
  [
    /connection error|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|other side closed|network/i,
    "network",
  ],
  [/refus|sensitive|content.(filter|policy)|safety/i, "content_filter"],
  [
    /unauthori[sz]ed|invalid.{0,40}(api.?key|token)|authentication/i,
    "authentication",
  ],
];

/** Failures a later attempt may get past without any change. */
const retryableCategories = new Set<ModelFailureCategory>([
  "rate_limit",
  "overloaded",
  "unavailable",
  "server_error",
  "timeout",
  "network",
  "stream_interrupted",
  "fast_mode_limited",
]);

/** The parts of a provider's JSON error body worth keeping, before redaction. */
export interface ProviderErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly requestId?: string;
}

/**
 * Diagnose a failed model request from Pi's error message and the provider's last response. SDKs
 * put the status first and the provider's JSON body after it, as in `429 {"type":"error",...}`;
 * stream failures after a successful response carry only the body or a transport message.
 */
export function classifyModelFailure(input: ModelFailureInput): ModelFailure {
  const raw = input.errorMessage ?? "";
  const statusMatch = /^\s*(\d{3})\b\s*/.exec(raw);
  const parsedStatus = statusMatch ? Number(statusMatch[1]) : undefined;
  const remainder = statusMatch ? raw.slice(statusMatch[0].length) : raw;
  const body = providerErrorBody(remainder);
  const response = input.lastResponse;
  // A stream that fails after a successful response keeps that status, showing where it failed.
  const status = parsedStatus ?? response?.status;
  const code =
    safeIdentifier(body.code, 64) ?? safeIdentifier(response?.errorType, 64);
  const explanation =
    body.message ?? (remainder.trim() || undefined) ?? response?.errorMessage;
  // Wording is matched in a bounded prefix, so classifying never depends on the text's length.
  const category = categorize(
    input,
    status,
    code,
    (explanation ?? "").slice(0, classificationLimit),
  );
  const message = explanation
    ? redactText(explanation, modelFailureMessageLimit)
    : undefined;
  const requestId =
    safeIdentifier(body.requestId) ?? safeIdentifier(response?.requestId);
  return {
    category,
    retryable: retryableCategories.has(category),
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(message ? { message } : {}),
  };
}

/** Prefer a cancellation or refused Fast request, then the provider's code, status, and wording. */
function categorize(
  input: ModelFailureInput,
  status: number | undefined,
  code: string | undefined,
  explanation: string,
): ModelFailureCategory {
  if (input.stopReason === "aborted") return "cancelled";
  if (input.speedFailure === "rejected") return "fast_mode_rejected";
  if (input.speedFailure === "limited") return "fast_mode_limited";
  const byCode = code ? providerCodes[code.toLowerCase()] : undefined;
  const byMessage = messageCategories.find(([pattern]) =>
    pattern.test(explanation),
  )?.[1];
  // A rate limit that is really an exhausted quota or balance cannot be waited out.
  if ((byCode === "rate_limit" || status === 429) && byMessage === "quota")
    return "quota";
  if (
    (byCode === "invalid_request" || status === 400 || status === 413) &&
    byMessage === "context_length"
  )
    return "context_length";
  if (byCode) return byCode;
  if (status !== undefined) {
    const byStatus = statusCategories[status];
    if (byStatus) return byStatus;
    if (status >= 500) return "server_error";
    if (status >= 400) return "invalid_request";
  }
  return byMessage ?? "unknown";
}

/** The code, message, and request ID of a JSON error body, if the text contains one. */
export function providerErrorBody(text: string): ProviderErrorBody {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
  if (!value || typeof value !== "object") return {};
  const body = value as Record<string, unknown>;
  const inner =
    body.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : body;
  const typeOf = (record: Record<string, unknown>) =>
    [record.code, record.type].find(
      (entry) => typeof entry === "string" && entry !== "error",
    ) as string | undefined;
  const message = [inner.message, body.message].find(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  const requestId = [body.request_id, inner.request_id].find(
    (entry): entry is string => typeof entry === "string",
  );
  const code = typeOf(inner) ?? typeOf(body);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}
