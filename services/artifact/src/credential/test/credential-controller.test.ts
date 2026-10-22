import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type InjectOptions } from "fastify";
import { errorHandler } from "@everything/errors/fastify";
import type { ArtifactService } from "../../artifact/service/artifact-service.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import { strictRequestValidation } from "../../http/config/request-validation.js";
import { appCredentialController } from "../controller/app-credential-controller.js";
import { credentialController } from "../controller/credential-controller.js";
import { InvalidCredentialError } from "../error/credential-errors.js";
import type { AppCredentials } from "../service/app-credentials.js";
import type { CredentialDistribution } from "../service/credential-distribution.js";

const credentialId = "11111111-1111-4111-8111-111111111111";
const actor = {
  "x-everything-actor-id": "owner",
  "x-everything-actor-name": "You",
};

/** The credential endpoints over recording use cases, with production validation and errors. */
async function server() {
  const app = Fastify({ ajv: strictRequestValidation });
  app.setErrorHandler(errorHandler);
  const calls: unknown[] = [];
  await appCredentialController(
    app,
    {
      attach: async (ownerId, author, reference, grant) => {
        calls.push(["attach", ownerId, author, reference, grant.env]);
        return { id: "app" } as Artifact;
      },
      detach: async (ownerId, author, reference, env) => {
        calls.push(["detach", ownerId, author, reference, env]);
        return { id: "app" } as Artifact;
      },
    } satisfies Pick<AppCredentials, "attach" | "detach">,
    {
      details: async () => ({ credentials: [] }) as never,
    } satisfies Pick<ArtifactService, "details">,
  );
  await credentialController(app, {
    deliver: async (id, input) => {
      if (input.value.includes("invalid")) throw new InvalidCredentialError();
      calls.push(["deliver", id, input.version]);
      return { complete: true, apps: [] };
    },
    revoke: async (id) => {
      calls.push(["revoke", id]);
      return { complete: true, apps: [] };
    },
    uses: async () => [],
    inventory: async () => [],
  } satisfies Pick<
    CredentialDistribution,
    "deliver" | "revoke" | "uses" | "inventory"
  >);
  return { app, calls };
}

test("credential endpoints validate requests and never repeat a value in an answer", async (context) => {
  const { app, calls } = await server();
  context.after(() => app.close());
  const responses: string[] = [];
  const send = async (options: InjectOptions) => {
    const response = await app.inject(options);
    responses.push(response.body);
    return response;
  };
  const grant = {
    credentialId,
    env: "TOKEN",
    version: 1,
    valueId: "9c0b7a52-6d0e-4f0d-9a77-0f2a3f1f6c01",
    value: "ctl-sentinel-value",
    credentialGeneration: 0,
  };
  assert.equal(
    (
      await send({
        method: "POST",
        url: "/owners/owner/artifacts/app/credentials",
        headers: actor,
        payload: grant,
      })
    ).statusCode,
    200,
  );
  for (const payload of [
    { ...grant, value: "ctl-sentinel-".repeat(3000) },
    { ...grant, env: "1BAD" },
    { ...grant, version: 0 },
    { ...grant, credentialId: "ctl-sentinel-not-a-uuid" },
    { ...grant, valueId: "ctl-sentinel-not-a-uuid" },
    { ...grant, credentialGeneration: -1 },
    { ...grant, extra: "ctl-sentinel" },
  ])
    assert.equal(
      (
        await send({
          method: "POST",
          url: "/owners/owner/artifacts/app/credentials",
          headers: actor,
          payload,
        })
      ).statusCode,
      400,
    );
  assert.equal(
    (
      await send({
        method: "DELETE",
        url: "/owners/owner/artifacts/app/credentials/TOKEN",
        headers: actor,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await send({
        method: "PUT",
        url: `/credentials/${credentialId}/value`,
        payload: {
          version: 2,
          valueId: "9c0b7a52-6d0e-4f0d-9a77-0f2a3f1f6c02",
          value: "ctl-sentinel-rotated",
        },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await send({
        method: "PUT",
        url: `/credentials/${credentialId}/value`,
        payload: {
          version: 2,
          valueId: "9c0b7a52-6d0e-4f0d-9a77-0f2a3f1f6c03",
          value: "ctl-sentinel-invalid",
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await send({
        method: "POST",
        url: `/credentials/${credentialId}/revocation`,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await send({ method: "POST", url: "/credentials/not-an-id/revocation" }))
      .statusCode,
    400,
  );
  assert.deepEqual(calls, [
    ["attach", "owner", { id: "owner", name: "You" }, "app", "TOKEN"],
    ["detach", "owner", { id: "owner", name: "You" }, "app", "TOKEN"],
    ["deliver", credentialId, 2],
    ["revoke", credentialId],
  ]);
  for (const body of responses) assert.ok(!body.includes("ctl-sentinel"), body);
});
