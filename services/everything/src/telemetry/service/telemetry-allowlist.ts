import type { AttributeValue, Attributes } from "@opentelemetry/api";
import { telemetryAttributes } from "../model/telemetry-attributes.js";
import {
  redactPath,
  redactText,
  redactUrl,
  safeIdentifier,
} from "./telemetry-redactor.js";

/** How one exported attribute's value is made safe. */
type Sanitizer = (value: AttributeValue) => AttributeValue | undefined;

/** What an export keeps besides structured facts. */
export interface ExportPolicy {
  /** Keep the redacted text of error messages; see `TelemetrySettings.includeErrorText`. */
  readonly includeErrorText: boolean;
}

/** The default: error text is withheld. */
export const defaultExportPolicy: ExportPolicy = { includeErrorText: false };

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

/** A URL without credentials, query string, or fragment. */
const url: Sanitizer = (value) =>
  typeof value === "string" ? redactUrl(value) : undefined;

/** A path without credentials, query string, or fragment. */
const path: Sanitizer = (value) =>
  typeof value === "string" ? redactPath(value) : undefined;

/** A short identifier only. */
const identifier: Sanitizer = (value) =>
  safeIdentifier(value, 128) ?? scalar(value);

/**
 * Attributes holding the text of error messages from providers, SDKs, libraries, and thrown
 * errors. Such text can quote what was sent, such as part of a prompt, so it is exported only when
 * the installation records error text.
 */
const errorTextAttributes: ReadonlySet<string> = new Set([
  telemetryAttributes.message,
  "exception.message",
]);

/** Everything's own attributes, each by its declared name only. */
const ownAttributes: Readonly<Record<string, Sanitizer>> = Object.fromEntries(
  Object.values(telemetryAttributes).map((name) => [name, text]),
);

/**
 * Every attribute that may leave the process, with how its value is made safe. Anything else an
 * instrumented library records, such as SQL statements, connection strings, headers, user agents,
 * client addresses, and query strings, is dropped before export.
 */
const exportedAttributes: Readonly<Record<string, Sanitizer>> = {
  ...ownAttributes,
  [telemetryAttributes.message]: errorText,
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
 * Attributes reduced to the allowlist, with every value made safe. Error text is left out unless
 * `policy` records it.
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
    const safe = sanitize(value);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
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
