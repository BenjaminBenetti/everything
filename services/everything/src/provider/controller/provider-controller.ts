import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { ProviderConnections } from "../interface/provider-connections.js";
import {
  providerAuthorizationResponse,
  providerDisconnectionResponse,
  providerListResponse,
  providerResponse,
} from "../schema/provider-response.js";
import {
  apiKeyProviderParams,
  completeProviderBody,
  providerParams,
  saveProviderBody,
  type ApiKeyProviderParams,
  type CompleteProviderBody,
  type ProviderParams,
  type SaveProviderBody,
} from "../schema/provider-request.js";

/** Register authenticated connection management without any teammate or session creation. */
export async function providerController(
  app: FastifyInstance,
  providers: ProviderConnections,
): Promise<void> {
  app.get(
    "/providers",
    {
      schema: {
        summary: "List your model provider connections",
        response: { 200: providerListResponse },
      },
    },
    async (request) => ({
      providers: await providers.list(subject(request)),
    }),
  );
  app.put<{ Params: ApiKeyProviderParams; Body: SaveProviderBody }>(
    "/providers/:provider",
    {
      schema: {
        summary: "Save a model provider connection",
        description:
          "API keys are write-only; omitting the key keeps an existing key for the same address.",
        params: apiKeyProviderParams,
        body: saveProviderBody,
        response: { 200: providerResponse },
      },
    },
    async (request) =>
      providers.save(subject(request), request.params.provider, request.body),
  );
  app.post<{ Params: ProviderParams }>(
    "/providers/:provider/verify",
    {
      schema: {
        summary: "Verify a model provider connection",
        params: providerParams,
        response: { 200: providerResponse },
      },
    },
    async (request) =>
      providers.verify(subject(request), request.params.provider),
  );
  app.delete<{ Params: ProviderParams }>(
    "/providers/:provider",
    {
      schema: {
        summary: "Disconnect a model provider",
        params: providerParams,
        response: { 200: providerDisconnectionResponse },
      },
    },
    async (request) =>
      providers.disconnect(subject(request), request.params.provider),
  );
  app.post(
    "/providers/chatgpt/authorize",
    {
      schema: {
        summary: "Start provider browser authorization",
        response: { 200: providerAuthorizationResponse },
      },
    },
    async (request) => providers.authorize(subject(request)),
  );
  app.post<{ Body: CompleteProviderBody }>(
    "/providers/chatgpt/complete",
    {
      schema: {
        summary: "Complete provider browser authorization",
        body: completeProviderBody,
        response: { 200: providerResponse },
      },
    },
    async (request) =>
      providers.complete(subject(request), request.body.callback),
  );
}
