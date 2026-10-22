import type { FastifyInstance, FastifyRequest } from "fastify";
import { keyTypes } from "@everything/key-contracts";
import { subject } from "@everything/security/fastify";
import { noContentResponse } from "../../http/schema/http-response.js";
import type { KeyOperations } from "../interface/key-operations.js";
import type { KeyActor } from "../model/key-actor.js";
import type { CredentialRollouts } from "../../credential/service/credential-rollouts.js";
import type { CredentialGrants } from "../../credential/service/credential-grants.js";
import { InvalidKeyError } from "../error/key-errors.js";
import {
  createKeyBody,
  keyParams,
  renameKeyBody,
  replaceKeyValueBody,
  type CreateKeyBody,
  type KeyParams,
  type RenameKeyBody,
  type ReplaceKeyValueBody,
} from "../schema/key-request.js";
import {
  credentialUsageResponse,
  keyListResponse,
  keyRemovalResponse,
  keyReplacementResponse,
  keyResponse,
} from "../schema/key-response.js";

/** The verified account, and the app whose own token made the request, if any. */
export function keyActor(request: FastifyRequest): KeyActor {
  const app = request.identity?.app;
  return { subject: subject(request), ...(app ? { app } : {}) };
}

/** Register authenticated metadata management; no endpoint returns key material. */
export async function keyController(
  app: FastifyInstance,
  keys: KeyOperations,
  credentials: {
    readonly rollouts: Pick<CredentialRollouts, "deliver" | "revoke">;
    readonly grants: Pick<CredentialGrants, "usage">;
  },
): Promise<void> {
  app.get(
    "/keys",
    {
      schema: {
        summary: "List the installation’s shared keys",
        description:
          "Returns metadata only: never a key's contents or a credential's value.",
        response: { 200: keyListResponse },
      },
    },
    async (request) => ({ keys: await keys.list(keyActor(request)) }),
  );
  app.post<{ Body: CreateKeyBody }>(
    "/keys",
    {
      schema: {
        summary: "Store an encrypted key or generic credential",
        description:
          "Type `ssh` stores an SSH key. Type `generic` stores a named secret value, up to 32 KB, kept exactly as sent; it can be given to apps later and is never returned. Apps' own tokens can't add generic credentials.",
        body: createKeyBody,
        response: { 201: keyResponse },
      },
    },
    async (request, reply) => {
      const type = keyTypes.find((type) => type.id === request.body.type)?.id;
      if (!type) throw new InvalidKeyError();
      return reply
        .code(201)
        .send(await keys.create(keyActor(request), { ...request.body, type }));
    },
  );
  app.patch<{ Params: KeyParams; Body: RenameKeyBody }>(
    "/keys/:keyId",
    {
      schema: {
        summary: "Rename a saved key",
        description:
          "Changes the name, and a generic credential's description. Apps that receive a credential keep it after a rename.",
        params: keyParams,
        body: renameKeyBody,
        response: { 200: keyResponse },
      },
    },
    async (request) =>
      keys.rename(keyActor(request), request.params.keyId, request.body),
  );
  app.put<{ Params: KeyParams; Body: ReplaceKeyValueBody }>(
    "/keys/:keyId/value",
    {
      schema: {
        summary: "Replace a generic credential's value",
        description:
          "Only the account that added the credential can replace its value. Every app that receives it restarts with the new value; the response reports each app's status, and `complete` is false until every app has the new value stored. The value is never returned.",
        params: keyParams,
        body: replaceKeyValueBody,
        response: { 200: keyReplacementResponse },
      },
    },
    async (request) => {
      const actor = keyActor(request);
      const key = await keys.replaceValue(
        actor,
        request.params.keyId,
        request.body,
      );
      return {
        key,
        rollout: await credentials.rollouts.deliver(actor, key.id),
      };
    },
  );
  app.get<{ Params: KeyParams }>(
    "/keys/:keyId/apps",
    {
      schema: {
        summary: "List the apps that use a generic credential",
        description:
          "Lists your apps that receive the credential, or still hold it while they restart, with each one's variable and status. Other accounts' apps are only counted.",
        params: keyParams,
        response: { 200: credentialUsageResponse },
      },
    },
    async (request) =>
      credentials.grants.usage(keyActor(request), request.params.keyId),
  );
  app.delete<{ Params: KeyParams }>(
    "/keys/:keyId",
    {
      schema: {
        summary: "Delete a saved key",
        description:
          "SSH keys are deleted at once (204). A generic credential's value is erased at once and the credential is removed from every app that receives it, restarting them (200 with the removal's status). Until every app has stopped using it, the credential stays listed as removing and Everything keeps retrying.",
        params: keyParams,
        response: { 200: keyRemovalResponse, 204: noContentResponse },
      },
    },
    async (request, reply) => {
      const actor = keyActor(request);
      const type = await keys.delete(actor, request.params.keyId);
      if (type !== "generic") return reply.code(204).send();
      return {
        rollout: await credentials.rollouts.revoke(actor, request.params.keyId),
      };
    },
  );
}
