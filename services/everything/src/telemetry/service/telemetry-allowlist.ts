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

/** Longest string attribute value, after redaction. */
const valueLimit = 512;

/** Text, redacted and bounded. */
const text: Sanitizer = (value) =>
  typeof value === "string" ? redactText(value, valueLimit) : scalar(value);

/** Numbers and booleans as they are; anything else is dropped. */
function scalar(value: AttributeValue): AttributeValue | undefined {
  return typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

/** A URL without credentials, query string, or fragment. */
const url: Sanitizer = (value) =>
  typeof value === "string" ? redactUrl(value) : undefined;

/** A path without query string or fragment. */
const path: Sanitizer = (value) =>
  typeof value === "string" ? redactPath(value) : undefined;

/** A short identifier only. */
const identifier: Sanitizer = (value) =>
  safeIdentifier(value, 128) ?? scalar(value);

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
  "exception.message": text,
};

/** A status code recorded as text by some libraries, as a number. */
function scalarOrNumber(value: AttributeValue): AttributeValue | undefined {
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return scalar(value);
}

/** Attributes reduced to the allowlist, with every value made safe. */
export function exportableAttributes(attributes: Attributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const sanitize = exportedAttributes[key];
    if (!sanitize || value === undefined || value === null) continue;
    const safe = sanitize(value);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
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
