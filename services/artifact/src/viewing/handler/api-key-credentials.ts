import type { FastifyRequest } from "fastify";
import { appApiKeyHeader } from "@everything/artifact-contracts/api-key";

/** The API key header as Node names it in parsed requests. */
export const apiKeyHeader = appApiKeyHeader.toLowerCase();

/**
 * The API key a request presents, or undefined when it sends none. Node joins repeated headers
 * with commas, so a repeated key arrives as one value that is never a well-formed key.
 */
export function presentedApiKey(request: FastifyRequest): string | undefined {
  const value = request.headers[apiKeyHeader];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}
