import type { FastifyInstance } from "fastify";
import {
  credentialParams,
  credentialValueBody,
  type CredentialParams,
  type CredentialValueBody,
} from "../schema/credential-request.js";
import type { CredentialDistribution } from "../service/credential-distribution.js";

/**
 * Register the internal endpoints Everything uses to deliver, revoke, and track a credential
 * across every app. Responses carry identifiers and statuses, never values.
 */
export async function credentialController(
  app: FastifyInstance,
  distribution: Pick<
    CredentialDistribution,
    "deliver" | "revoke" | "uses" | "inventory"
  >,
): Promise<void> {
  app.get("/credentials", async () => ({
    credentials: await distribution.inventory(),
  }));

  app.get<{ Params: CredentialParams }>(
    "/credentials/:credentialId/apps",
    { schema: { params: credentialParams } },
    async (request) => ({
      apps: await distribution.uses(request.params.credentialId),
    }),
  );

  app.put<{ Params: CredentialParams; Body: CredentialValueBody }>(
    "/credentials/:credentialId/value",
    { schema: { params: credentialParams, body: credentialValueBody } },
    async (request) =>
      distribution.deliver(request.params.credentialId, request.body),
  );

  app.post<{ Params: CredentialParams }>(
    "/credentials/:credentialId/revocation",
    { schema: { params: credentialParams } },
    async (request) => distribution.revoke(request.params.credentialId),
  );
}
