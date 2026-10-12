import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { ProviderConnections } from "../interface/provider-connections.js";
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
  app.get("/providers", async (request) => ({
    providers: await providers.list(subject(request)),
  }));
  app.put<{ Params: ApiKeyProviderParams; Body: SaveProviderBody }>(
    "/providers/:provider",
    {
      schema: { params: apiKeyProviderParams, body: saveProviderBody },
    },
    async (request) =>
      providers.save(subject(request), request.params.provider, request.body),
  );
  app.post<{ Params: ProviderParams }>(
    "/providers/:provider/verify",
    {
      schema: { params: providerParams },
    },
    async (request) =>
      providers.verify(subject(request), request.params.provider),
  );
  app.delete<{ Params: ProviderParams }>(
    "/providers/:provider",
    { schema: { params: providerParams } },
    async (request) =>
      providers.disconnect(subject(request), request.params.provider),
  );
  app.post("/providers/chatgpt/authorize", async (request) =>
    providers.authorize(subject(request)),
  );
  app.post<{ Body: CompleteProviderBody }>(
    "/providers/chatgpt/complete",
    { schema: { body: completeProviderBody } },
    async (request) =>
      providers.complete(subject(request), request.body.callback),
  );
}
