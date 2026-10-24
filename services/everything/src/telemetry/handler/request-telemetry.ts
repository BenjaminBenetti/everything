import { trace } from "@opentelemetry/api";
import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import { ApplicationError } from "@everything/errors";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
} from "../model/telemetry-attributes.js";
import {
  bindRequestOwner,
  failTelemetrySpan,
  recordTelemetryEvent,
} from "../service/telemetry-recorder.js";
import { describeError } from "../service/telemetry-redactor.js";

/** Teammate identifiers in route parameters; anything else is not attributed. */
const agentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Name each request's span by its route rather than its URL, so identifiers and query strings stay
 * out of names, and record a server failure as a durable event with a safe description. The
 * response is unchanged: callers still receive only the error handler's public code and message.
 */
export async function registerRequestTelemetry(
  app: FastifyInstance,
): Promise<void> {
  app.addHook("onRequest", async (request) => {
    const span = trace.getActiveSpan();
    const route = request.routeOptions.url;
    if (!span?.isRecording() || !route) return;
    span.setAttribute(attribute.httpRoute, route);
    span.updateName(`${request.method} ${route}`);
  });
  app.addHook("onError", async (request, _reply, error) => {
    recordRequestFailure(request, error);
  });
}

/**
 * Attribute a request to its verified owner once authentication has run, with the teammate its
 * route names. Register inside the protected scope, after its authentication hook.
 */
export function bindAuthenticatedRequest(request: FastifyRequest): void {
  if (!request.identity) return;
  bindRequestOwner(request.identity.subject, routeAgentId(request));
}

/** The teammate a route's `agentId` parameter names, when it is a well-formed identifier. */
function routeAgentId(request: FastifyRequest): string | undefined {
  const agentId = (request.params as Record<string, unknown> | undefined)
    ?.agentId;
  return typeof agentId === "string" && agentIdPattern.test(agentId)
    ? agentId
    : undefined;
}

/**
 * Record a failed request: unexpected failures as errors with their redacted cause, and expected
 * failures the service reports as unavailable as warnings. Client errors are visible on the
 * request's span only.
 */
function recordRequestFailure(
  request: FastifyRequest,
  error: FastifyError | Error,
): void {
  const expected = error instanceof ApplicationError;
  const failure = error as { statusCode?: number; validation?: unknown };
  const status = expected
    ? error.status
    : failure.validation
      ? 400
      : (failure.statusCode ?? 500);
  if (status < 500) return;
  const span = trace.getActiveSpan();
  if (span && !expected) failTelemetrySpan(span, error);
  const agentId = routeAgentId(request);
  const route = request.routeOptions.url;
  const description = expected ? undefined : describeError(error);
  recordTelemetryEvent({
    name: telemetryEvents.requestFailed,
    title: expected ? "Request could not be completed" : "Request failed",
    type: "http",
    severity: expected ? "warning" : "error",
    outcome: "failure",
    httpStatus: status,
    ...(expected
      ? { code: error.code }
      : { code: description?.code ?? "INTERNAL_ERROR", error: description! }),
    attributes: {
      [attribute.httpMethod]: request.method,
      ...(route ? { [attribute.httpRoute]: route } : {}),
    },
    ...(request.identity
      ? {
          scope: {
            ownerId: request.identity.subject,
            ...(agentId ? { agentId } : {}),
          },
        }
      : {}),
  });
}
