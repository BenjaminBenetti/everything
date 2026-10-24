import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** An OTLP attribute value as JSON encodes it. */
interface OtlpValue {
  readonly stringValue?: string;
  readonly intValue?: string | number;
  readonly boolValue?: boolean;
  readonly doubleValue?: number;
}

/** OTLP attributes as JSON encodes them. */
type OtlpAttributes = readonly { key: string; value: OtlpValue }[];

/** A received span, with attributes as a plain object. */
export interface ReceivedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly attributes: Record<string, unknown>;
  readonly status: { code?: number; message?: string };
  readonly events: { name: string; attributes: Record<string, unknown> }[];
}

/** A received log record, with attributes as a plain object. */
export interface ReceivedLog {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly severityText?: string;
  readonly body?: string;
  readonly attributes: Record<string, unknown>;
}

/** Convert OTLP JSON attributes to an object. */
function attributes(list: OtlpAttributes | undefined): Record<string, unknown> {
  return Object.fromEntries(
    (list ?? []).map(({ key, value }) => [
      key,
      value.stringValue ??
        (value.intValue !== undefined ? Number(value.intValue) : undefined) ??
        value.boolValue ??
        value.doubleValue,
    ]),
  );
}

/**
 * A local stand-in for OpenObserve's OTLP/HTTP JSON endpoints that keeps every request's headers
 * and decoded records, so tests can check exactly what left the process.
 */
export async function startOtlpReceiver() {
  const headers: IncomingHttpHeaders[] = [];
  const bodies: string[] = [];
  const spans: ReceivedSpan[] = [];
  const logs: ReceivedLog[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      headers.push(request.headers);
      bodies.push(text);
      const body = JSON.parse(text) as {
        resourceSpans?: {
          scopeSpans: { spans: Record<string, unknown>[] }[];
        }[];
        resourceLogs?: {
          scopeLogs: { logRecords: Record<string, unknown>[] }[];
        }[];
      };
      for (const resource of body.resourceSpans ?? [])
        for (const scope of resource.scopeSpans)
          for (const span of scope.spans)
            spans.push({
              traceId: span.traceId as string,
              spanId: span.spanId as string,
              ...(span.parentSpanId
                ? { parentSpanId: span.parentSpanId as string }
                : {}),
              name: span.name as string,
              kind: span.kind as number,
              attributes: attributes(span.attributes as OtlpAttributes),
              status: (span.status ?? {}) as ReceivedSpan["status"],
              events: (
                (span.events ?? []) as {
                  name: string;
                  attributes: OtlpAttributes;
                }[]
              ).map((event) => ({
                name: event.name,
                attributes: attributes(event.attributes),
              })),
            });
      for (const resource of body.resourceLogs ?? [])
        for (const scope of resource.scopeLogs)
          for (const record of scope.logRecords)
            logs.push({
              ...(record.traceId ? { traceId: record.traceId as string } : {}),
              ...(record.spanId ? { spanId: record.spanId as string } : {}),
              ...(record.severityText
                ? { severityText: record.severityText as string }
                : {}),
              ...(record.body
                ? { body: (record.body as OtlpValue).stringValue! }
                : {}),
              attributes: attributes(record.attributes as OtlpAttributes),
            });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    headers,
    bodies,
    spans,
    logs,
    /** Stop listening. */
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
