import type { FastifyReply, FastifyRequest } from "fastify";
import { ApplicationError } from "../model/application-error.js";

/** A stable, caller-safe error body. */
interface PublicFailure {
  readonly code: string;
  readonly message: string;
}

/** Framework failures the caller can correct, keyed by HTTP status. */
const correctableFailures: Readonly<Record<number, PublicFailure>> = {
  400: {
    code: "INVALID_REQUEST",
    message: "The request does not match the API schema.",
  },
  413: { code: "REQUEST_TOO_LARGE", message: "The request body is too large." },
  415: {
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "The request's content type isn't supported.",
  },
  429: { code: "RATE_LIMITED", message: "Too many requests." },
};

/** Response for anything unexpected; details are logged, never returned. */
const internalFailure: PublicFailure = {
  code: "INTERNAL_ERROR",
  message: "The request could not be completed.",
};

/** Map failures to stable public codes without exposing internal or provider details. */
export async function errorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (error instanceof ApplicationError)
    return reply
      .code(error.status)
      .send({ code: error.code, message: error.message });
  const failure = error as {
    validation?: unknown;
    statusCode?: number;
    code?: string;
  };
  const status = failure.validation ? 400 : (failure.statusCode ?? 500);
  const correctable = correctableFailures[status];
  if (correctable) return reply.code(status).send(correctable);
  request.log.error(
    { code: failure.code ?? internalFailure.code },
    "Request failed",
  );
  return reply.code(500).send(internalFailure);
}
