import type { AttributeValue, Attributes } from "@opentelemetry/api";
import { telemetryLimits } from "@everything/telemetry-contracts";
import {
  attributeValueLengthLimit,
  promptSources,
  telemetryAttributes,
} from "../model/telemetry-attributes.js";
import { sqlStatementPreview } from "./sql-statement.js";
import {
  redactPath,
  redactStart,
  redactText,
  redactUrl,
  safeIdentifier,
  truncationMarker,
} from "./telemetry-redactor.js";
import { fitUtf8 } from "./text-budget.js";
import { toolArgumentsPreview } from "./tool-arguments-preview.js";

/** How one exported attribute's value is made safe. */
type Sanitizer = (value: AttributeValue) => AttributeValue | undefined;

/** What an export keeps besides structured facts. */
export interface ExportPolicy {
  /** Keep the redacted text of error messages; see `TelemetrySettings.includeErrorText`. */
  readonly includeErrorText: boolean;
  /** Keep content previews; see `TelemetrySettings.includeContent`. */
  readonly includeContent: boolean;
}

/**
 * The policy when none is given: nothing beyond structured facts. Installations record error text
 * and content by default through their settings; code that names no policy keeps neither.
 */
export const defaultExportPolicy: ExportPolicy = {
  includeErrorText: false,
  includeContent: false,
};

/** Longest string attribute value, after redaction. */
const valueLimit = 512;

/** Longest error message or span status message, after redaction, when error text is recorded. */
export const errorTextLimit = 400;

/** Text, redacted and bounded. */
const text: Sanitizer = (value) =>
  typeof value === "string" ? redactText(value, valueLimit) : scalar(value);

/** Error text, redacted and bounded; exported only when the installation records error text. */
const errorText: Sanitizer = (value) =>
  typeof value === "string" ? redactText(value, errorTextLimit) : undefined;

/** Numbers and booleans as they are; anything else is dropped. */
function scalar(value: AttributeValue): AttributeValue | undefined {
  return typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

/** A message preview, redacted again and bounded, in case anything else set it. */
const preview: Sanitizer = (value) => {
  if (typeof value !== "string") return undefined;
  const budget = telemetryLimits.previewBytes;
  const { text } = redactStart(value, budget * 2 + 512);
  return fitUtf8(text, budget, truncationMarker).text;
};

/** A tool call's arguments preview, read as JSON and previewed again, or as text if it isn't JSON. */
const toolArguments: Sanitizer = (value) => {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(0, attributeValueLengthLimit));
  } catch {
    return preview(value);
  }
  return toolArgumentsPreview(parsed).text;
};

/** An SQL statement's shape: literals and comments removed, credentials redacted, bounded. */
const sqlStatement: Sanitizer = (value) =>
  typeof value === "string"
    ? sqlStatementPreview(value, {
        // A statement this long may have been cut when the instrumentation set it.
        cut: value.length >= attributeValueLengthLimit,
      }).text
    : undefined;

/** A prompt's source, from Everything's fixed catalog only. */
const promptSource: Sanitizer = (value) =>
  (promptSources as readonly AttributeValue[]).includes(value)
    ? value
    : undefined;

/** A URL without credentials, query string, or fragment. */
const url: Sanitizer = (value) =>
  typeof value === "string" ? redactUrl(value) : undefined;

/** A path without credentials, query string, or fragment. */
const path: Sanitizer = (value) =>
  typeof value === "string" ? redactPath(value) : undefined;

/**
 * The redaction marker as a complete part of an identifier, at either end or between separators, as
 * redaction leaves it in one, such as `tool-[redacted]` or `password:[redacted]`.
 */
const markerPart = /(?<=^|[_.:/-])\[redacted\](?=$|[_.:/-])/g;

/**
 * A short identifier only, with any credential it spells redacted: a well-formed identifier, such
 * as a tool name a model chose or a gateway's host, can still be a key. An identifier already made
 * safe, whose markers are each a complete part of it, is kept as it is, so making a record safe
 * again changes nothing. A marker joined to other text, such as `password:[redacted]…` with more
 * after it, could hide anything, so that value is dropped.
 */
const identifier: Sanitizer = (value) => {
  const valid =
    typeof value === "string" &&
    safeIdentifier(value.replace(markerPart, "x"), 128) !== undefined
      ? value
      : safeIdentifier(value, 128);
  return valid === undefined ? scalar(value) : redactText(valid, 128);
};

/**
 * Attributes holding the text of error messages from providers, SDKs, libraries, and thrown
 * errors. Such text can quote what was sent, such as part of a prompt, so it is exported only when
 * the installation records error text.
 */
const errorTextAttributes: ReadonlySet<string> = new Set([
  telemetryAttributes.message,
  "exception.message",
]);

/**
 * Attributes holding content previews: a message, a tool call's arguments, and SQL statements,
 * with the facts that describe them. They are exported only when the installation records content.
 */
const contentAttributes: ReadonlySet<string> = new Set([
  telemetryAttributes.messagePreview,
  telemetryAttributes.messageLength,
  telemetryAttributes.messageTruncated,
  telemetryAttributes.toolArguments,
  telemetryAttributes.toolArgumentsTruncated,
  telemetryAttributes.dbQueryText,
  telemetryAttributes.dbStatement,
]);

/** The content attributes whose absence a reader notices, marked withheld when left out. */
const contentPreviews: readonly string[] = [
  telemetryAttributes.messagePreview,
  telemetryAttributes.toolArguments,
  telemetryAttributes.dbQueryText,
  telemetryAttributes.dbStatement,
];

/** Everything's own attributes, each by its declared name only. */
const ownAttributes: Readonly<Record<string, Sanitizer>> = Object.fromEntries(
  Object.values(telemetryAttributes).map((name) => [name, text]),
);

/**
 * Every attribute that may leave the process, with how its value is made safe. Anything else an
 * instrumented library records, such as SQL parameter values, connection strings, headers, user
 * agents, client addresses, and query strings, is dropped before export. SQL statements are kept
 * only as their shape, without literals, and only when the installation records content.
 */
const exportedAttributes: Readonly<Record<string, Sanitizer>> = {
  ...ownAttributes,
  [telemetryAttributes.message]: errorText,
  [telemetryAttributes.messagePreview]: preview,
  [telemetryAttributes.toolArguments]: toolArguments,
  [telemetryAttributes.dbQueryText]: sqlStatement,
  [telemetryAttributes.dbStatement]: sqlStatement,
  [telemetryAttributes.promptSource]: promptSource,
  [telemetryAttributes.reason]: identifier,
  [telemetryAttributes.tool]: identifier,
  [telemetryAttributes.urlFull]: url,
  [telemetryAttributes.urlPath]: path,
  "http.url": url,
  "http.target": path,
  [telemetryAttributes.httpMethod]: identifier,
  "http.method": identifier,
  [telemetryAttributes.httpStatus]: scalarOrNumber,
  "http.status_code": scalarOrNumber,
  [telemetryAttributes.httpRoute]: path,
  "url.scheme": identifier,
  [telemetryAttributes.serverAddress]: identifier,
  "server.port": scalar,
  "net.peer.name": identifier,
  "net.peer.port": scalar,
  "network.protocol.version": identifier,
  "error.type": identifier,
  "db.system": identifier,
  "db.system.name": identifier,
  "db.name": identifier,
  "db.namespace": identifier,
  "db.operation": identifier,
  "db.operation.name": identifier,
  "db.collection.name": identifier,
  "db.sql.table": identifier,
  "exception.type": identifier,
  "exception.message": errorText,
};

/** A status code recorded as text by some libraries, as a number. */
function scalarOrNumber(value: AttributeValue): AttributeValue | undefined {
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return scalar(value);
}

/**
 * Attributes reduced to the allowlist, with every value made safe. Error text and content are left
 * out unless `policy` records them.
 */
export function exportableAttributes(
  attributes: Attributes,
  policy: ExportPolicy = defaultExportPolicy,
): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const sanitize = exportedAttributes[key];
    if (!sanitize || value === undefined || value === null) continue;
    if (!policy.includeErrorText && errorTextAttributes.has(key)) continue;
    if (!policy.includeContent && contentAttributes.has(key)) continue;
    const safe = sanitize(value);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

/** Whether exporting `attributes` under `policy` leaves a content preview out. */
export function withholdsContent(
  attributes: Attributes,
  policy: ExportPolicy,
): boolean {
  return (
    !policy.includeContent && contentPreviews.some((key) => !!attributes[key])
  );
}

/** Whether exporting `attributes` under `policy` leaves error text out. */
export function withholdsErrorText(
  attributes: Attributes,
  policy: ExportPolicy,
): boolean {
  return (
    !policy.includeErrorText &&
    [...errorTextAttributes].some((key) => !!attributes[key])
  );
}

/** Span events that may leave the process; others, which libraries may add, are dropped. */
export const exportedSpanEvents = new Set([
  "exception",
  "provider.response",
  "compaction.start",
  "compaction.end",
  "summarization.retry",
  "retry.scheduled",
]);
