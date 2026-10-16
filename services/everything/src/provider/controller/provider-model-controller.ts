import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import type { ProviderModels } from "../interface/provider-models.js";
import { providerModelsResponse } from "../schema/provider-response.js";
import {
  providerParams,
  type ProviderParams,
} from "../schema/provider-request.js";

/** Expose only safe model metadata for the authenticated owner's active connection. */
export async function providerModelController(
  app: FastifyInstance,
  models: Pick<ProviderModels, "list">,
): Promise<void> {
  app.get<{ Params: ProviderParams }>(
    "/providers/:provider/models",
    {
      schema: {
        summary: "List available models and effort levels",
        params: providerParams,
        response: { 200: providerModelsResponse },
      },
    },
    async (request) => ({
      models: await models.list(subject(request), request.params.provider),
    }),
  );
}
