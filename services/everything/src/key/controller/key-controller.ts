import type { FastifyInstance } from "fastify";
import { keyTypes } from "@everything/key-contracts";
import { subject } from "@everything/security/fastify";
import { noContentResponse } from "../../http/schema/http-response.js";
import type { KeyOperations } from "../interface/key-operations.js";
import { InvalidKeyError } from "../error/key-errors.js";
import {
  createKeyBody,
  keyParams,
  renameKeyBody,
  type CreateKeyBody,
  type KeyParams,
  type RenameKeyBody,
} from "../schema/key-request.js";
import { keyResponse, keyListResponse } from "../schema/key-response.js";

/** Register authenticated metadata management; no endpoint returns key material. */
export async function keyController(
  app: FastifyInstance,
  keys: KeyOperations,
): Promise<void> {
  app.get(
    "/keys",
    {
      schema: {
        summary: "List the installation’s shared keys",
        response: { 200: keyListResponse },
      },
    },
    async (request) => ({ keys: await keys.list(subject(request)) }),
  );
  app.post<{ Body: CreateKeyBody }>(
    "/keys",
    {
      schema: {
        summary: "Store an encrypted key",
        body: createKeyBody,
        response: { 201: keyResponse },
      },
    },
    async (request, reply) => {
      const type = keyTypes.find((type) => type.id === request.body.type)?.id;
      if (!type) throw new InvalidKeyError();
      return reply
        .code(201)
        .send(await keys.create(subject(request), { ...request.body, type }));
    },
  );
  app.patch<{ Params: KeyParams; Body: RenameKeyBody }>(
    "/keys/:keyId",
    {
      schema: {
        summary: "Rename a saved key",
        params: keyParams,
        body: renameKeyBody,
        response: { 200: keyResponse },
      },
    },
    async (request) =>
      keys.rename(subject(request), request.params.keyId, request.body),
  );
  app.delete<{ Params: KeyParams }>(
    "/keys/:keyId",
    {
      schema: {
        summary: "Delete a saved key",
        params: keyParams,
        response: { 204: noContentResponse },
      },
    },
    async (request, reply) => {
      await keys.delete(subject(request), request.params.keyId);
      return reply.code(204).send();
    },
  );
}
