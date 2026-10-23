import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { TelemetryQuery } from "@everything/telemetry-contracts";
import { errorResponse } from "../../http/schema/http-response.js";
import type { TelemetryReader } from "../interface/telemetry-reader.js";
import {
  telemetryEventParams,
  telemetryPageQuery,
  telemetryTraceParams,
  type TelemetryEventParams,
  type TelemetryPageQuery,
  type TelemetryTraceParams,
} from "../schema/telemetry-request.js";
import {
  telemetryEventPageResponse,
  telemetryEventResponse,
  telemetrySpanPageResponse,
  telemetryStatusResponse,
  telemetryTraceResponse,
} from "../schema/telemetry-response.js";

/**
 * Register read-only telemetry routes. Each returns only the signed-in owner's records: the owner
 * is the verified caller, never a parameter, and filters are validated before a query is built.
 */
export async function telemetryController(
  app: FastifyInstance,
  telemetry: TelemetryReader,
): Promise<void> {
  app.get(
    "/telemetry/status",
    {
      schema: {
        summary: "Report whether telemetry is turned on and available",
        response: { 200: telemetryStatusResponse },
      },
    },
    async () => telemetry.status(),
  );
  app.get<{ Querystring: TelemetryPageQuery }>(
    "/telemetry/events",
    {
      schema: {
        summary: "Search your recorded errors, warnings, and other events",
        querystring: telemetryPageQuery,
        response: { 200: telemetryEventPageResponse, 503: errorResponse },
      },
    },
    async (request) =>
      telemetry.events(subject(request), pageQuery(request.query)),
  );
  app.get<{ Params: TelemetryEventParams }>(
    "/telemetry/events/:eventId",
    {
      schema: {
        summary: "Read one event with its diagnosis",
        params: telemetryEventParams,
        response: {
          200: telemetryEventResponse,
          404: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (request) =>
      telemetry.event(subject(request), request.params.eventId),
  );
  app.get<{ Querystring: TelemetryPageQuery }>(
    "/telemetry/spans",
    {
      schema: {
        summary:
          "Search your recorded requests, dependency calls, and teammate work",
        querystring: telemetryPageQuery,
        response: { 200: telemetrySpanPageResponse, 503: errorResponse },
      },
    },
    async (request) =>
      telemetry.spans(subject(request), pageQuery(request.query)),
  );
  app.get<{ Params: TelemetryTraceParams }>(
    "/telemetry/traces/:traceId",
    {
      schema: {
        summary: "Read the spans and events of one trace",
        params: telemetryTraceParams,
        response: {
          200: telemetryTraceResponse,
          404: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (request) =>
      telemetry.trace(subject(request), request.params.traceId),
  );
}

/** The validated query string as the reader's filters, with the page size as a number. */
function pageQuery({ limit, ...filters }: TelemetryPageQuery): TelemetryQuery {
  return {
    ...filters,
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
  };
}
