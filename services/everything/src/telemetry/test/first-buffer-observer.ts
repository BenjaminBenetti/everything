import {
  BatchLogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  BatchSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";
import { ReadRequestFilter } from "../service/read-request-filter.js";

/** What one record held at a buffer's entry, copied there as plain data. */
export interface BufferedRecord {
  /** The span's name, or the event record's body. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  /** Everything the record carried that an export could: name, attributes, status, events, links. */
  readonly text: string;
  /** A plain record of its own, rather than the SDK's live record or a view that delegates to it. */
  readonly detached: boolean;
}

/** Records as they reached the first place each kind of telemetry is held. */
export interface FirstBufferObservations {
  /** Spans entering the read-request filter, which holds a read's spans until its request ends. */
  readonly held: BufferedRecord[];
  /** Spans entering the span batch queue. */
  readonly batchedSpans: BufferedRecord[];
  /** Event records entering the event batch queue. */
  readonly batchedLogs: BufferedRecord[];
  /** Failures to copy a record, kept for assertions outside the SDK's calls rather than thrown. */
  readonly errors: string[];
  /** The runtime's read-request filters seen, so a test can hand one a record directly. */
  readonly filters: Set<ReadRequestFilter>;
}

/** One wrapped method, and how to put it back exactly as it was. */
interface Wrapped {
  readonly owner: object;
  readonly key: string;
  readonly descriptor: PropertyDescriptor | undefined;
  readonly original: unknown;
}

/**
 * Watch the first buffers telemetry is held in: `ReadRequestFilter.onEnd`, before it holds a read
 * request's spans, and the span and event batch processors' entries, before they queue records.
 * Each wrapper copies the record it is given into plain data and then calls the original method
 * unchanged. Copying never throws into the SDK, which calls processors from the code being traced:
 * a failure is collected in `errors`, for the test to assert on afterwards. `restore` puts every
 * method back exactly as it was and says whether it did.
 */
export function observeFirstBuffers(): {
  readonly observations: FirstBufferObservations;
  restore(): boolean;
} {
  const observations: FirstBufferObservations = {
    held: [],
    batchedSpans: [],
    batchedLogs: [],
    errors: [],
    filters: new Set(),
  };
  const wrapped = [
    wrap(ReadRequestFilter.prototype, "onEnd", (record, filter) => {
      observations.filters.add(filter as ReadRequestFilter);
      observations.held.push(spanRecord(record as ReadableSpan));
    }),
    wrap(BatchSpanProcessor.prototype, "onEnd", (record) =>
      observations.batchedSpans.push(spanRecord(record as ReadableSpan)),
    ),
    wrap(BatchLogRecordProcessor.prototype, "onEmit", (record) =>
      observations.batchedLogs.push(logRecord(record as ReadableLogRecord)),
    ),
  ];

  /** Copy the record a wrapped method is called with, then call the method as it was. */
  function wrap(
    owner: object,
    key: string,
    copy: (record: unknown, receiver: unknown) => void,
  ): Wrapped {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const original = (owner as Record<string, unknown>)[key] as (
      this: unknown,
      ...parameters: unknown[]
    ) => unknown;
    Object.defineProperty(owner, key, {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...parameters: unknown[]) {
        try {
          copy(parameters[0], this);
        } catch (error) {
          observations.errors.push(`${key}: ${String(error)}`);
        }
        return original.apply(this, parameters);
      },
    });
    return { owner, key, descriptor, original };
  }

  return {
    observations,
    restore() {
      for (const { owner, key, descriptor } of wrapped)
        if (descriptor) Object.defineProperty(owner, key, descriptor);
        else delete (owner as Record<string, unknown>)[key];
      return wrapped.every(
        ({ owner, key, descriptor, original }) =>
          (owner as Record<string, unknown>)[key] === original &&
          (descriptor === undefined) === !Object.hasOwn(owner, key),
      );
    },
  };
}

/** Whether `record` is a plain object of its own, not a live SDK record or a view over one. */
function detached(record: object): boolean {
  const prototype = Object.getPrototypeOf(record) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** A span as plain data. */
function spanRecord(span: ReadableSpan): BufferedRecord {
  const attributes = { ...span.attributes };
  return {
    name: span.name,
    attributes,
    text: JSON.stringify({
      name: span.name,
      attributes,
      status: span.status,
      events: span.events.map((event) => ({
        name: event.name,
        attributes: event.attributes,
      })),
      links: span.links,
    }),
    detached: detached(span),
  };
}

/** An event record as plain data. */
function logRecord(record: ReadableLogRecord): BufferedRecord {
  const attributes = { ...record.attributes };
  return {
    name: typeof record.body === "string" ? record.body : "",
    attributes,
    text: JSON.stringify({
      body: record.body,
      eventName: record.eventName,
      attributes,
    }),
    detached: detached(record),
  };
}

/** Whether `text` holds an unpaired UTF-16 surrogate, which no valid UTF-8 can encode. */
export function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    text,
  );
}

/**
 * Which records carry which of `values`, by their keys rather than the values themselves, and how
 * many records are the SDK's own rather than detached, for a test's diagnostics.
 */
export function describeHeld(
  records: readonly BufferedRecord[],
  values: Readonly<Record<string, string>>,
): string {
  const findings = records
    .map((record) => ({
      name: record.name,
      keys: Object.entries(values)
        .filter(([, value]) => record.text.includes(value))
        .map(([key]) => key),
    }))
    .filter((finding) => finding.keys.length)
    .map((finding) => `${finding.name} [${finding.keys.join(", ")}]`);
  const attached = records.filter((record) => !record.detached).length;
  return `${findings.length ? findings.join("; ") : "none"}; ${attached} of ${records.length} are SDK records`;
}
