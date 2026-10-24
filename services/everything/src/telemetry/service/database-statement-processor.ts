import type { Context, Span as ApiSpan } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace";
import {
  attributeValueLengthLimit,
  telemetryAttributes as attribute,
} from "../model/telemetry-attributes.js";
import { sqlStatementPreview } from "./sql-statement.js";

/** Attributes that hold a database query's statement, under current and older conventions. */
const statementAttributes = [attribute.dbQueryText, attribute.dbStatement];

/**
 * Replace a query span's statement with its shape as the query starts, from the whole statement
 * the client was given: literals and comments removed, credentials redacted, and bounded. Only
 * `text` is read, never the query's parameter values. PostgreSQL's instrumentation calls this as
 * its request hook, synchronously after it records the statement and before the query runs, and
 * catches anything it throws, so the query is never affected.
 */
export function shapeQueryStatement(span: ApiSpan, text: unknown): void {
  if (typeof text !== "string") return;
  span.setAttribute(attribute.dbQueryText, sqlStatementPreview(text).text);
}

/**
 * Reduce each database span's statement to its shape as the span ends, before it waits in the
 * export queue, for statements that reached the span other than through the request hook. A
 * statement already shaped is unchanged. Only the span's copy changes; the query that ran, and its
 * parameter values, which are never recorded, don't.
 */
export class DatabaseStatementProcessor implements SpanProcessor {
  // ===========================================
  // Span lifecycle
  // ===========================================

  /** Nothing is known about the statement yet. */
  onStart(_span: Span, _parentContext: Context): void {}

  /** Replace the statement with its shape while the span can still change. */
  onEnding(span: Span): void {
    for (const key of statementAttributes) {
      const statement = span.attributes[key];
      if (typeof statement !== "string") continue;
      try {
        span.setAttribute(
          key,
          sqlStatementPreview(statement, {
            // A statement this long may have been cut when the instrumentation set it.
            cut: statement.length >= attributeValueLengthLimit,
          }).text,
        );
      } catch {
        // The SDK calls processors without a guard; a statement that can't be shaped is dropped.
        try {
          span.setAttribute(key, "");
        } catch {
          // The export allowlist shapes it again.
        }
      }
    }
  }

  /** Nothing to do once the span has ended. */
  onEnd(_span: ReadableSpan): void {}

  /** Nothing is buffered here. */
  async forceFlush(): Promise<void> {}

  /** Nothing is held here. */
  async shutdown(): Promise<void> {}
}
