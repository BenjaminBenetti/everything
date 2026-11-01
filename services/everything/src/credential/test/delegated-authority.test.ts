import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { errorHandler } from "@everything/errors/fastify";
import type { ArtifactDetails } from "@everything/artifact-contracts";
import type { ArtifactGateway } from "../../artifact/interface/artifact-gateway.js";
import { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import { conversationController } from "../../conversation/controller/conversation-controller.js";
import type { ConversationOperations } from "../../conversation/interface/conversation-operations.js";
import { strictRequestValidation } from "../../http/config/request-validation.js";
import { credentialController } from "../controller/credential-controller.js";
import { CredentialGrants } from "../service/credential-grants.js";
import { noCredentialGrants } from "./credential-fixture.js";

// Documents the intended authority of an app's everything-api token: it acts as the app's owner.
// The direct credential routes refuse it, but it can still message the owner's teammates, whose
// tools act for the owner, including attaching the owner's credentials. everything-api is a
// high-trust capability, not a sandbox.

const appId = "89bb2d67-090d-405a-84f8-880d9231c9c2";
const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

/** Routes authenticated as an app's own token acting for its owner. */
async function asApp() {
  const app = Fastify({ ajv: strictRequestValidation });
  app.setErrorHandler(errorHandler);
  app.decorateRequest("identity", null);
  app.addHook("onRequest", async (request) => {
    request.identity = { subject: "owner", app: appId };
  });
  return app;
}

test("an app's own token can't attach credentials directly, but can message the owner's teammates as the owner", async (context) => {
  const app = await asApp();
  context.after(() => app.close());
  const sent: string[] = [];
  const unused = new Proxy(
    {},
    { get: () => () => assert.fail("the refusal touches nothing else") },
  );
  await credentialController(
    app,
    new CredentialGrants(
      unused as never,
      unused as never,
      unused as never,
      unused as never,
    ),
  );
  await conversationController(app, {
    send: async (ownerId: string, id: string, input: { text: string }) => {
      sent.push(`${ownerId}:${id}:${input.text}`);
      return { messageId: "message", runId: "run" };
    },
  } as unknown as ConversationOperations);
  const attached = await app.inject({
    method: "POST",
    url: `/artifacts/${appId}/credentials`,
    payload: {
      credentialId: "11111111-1111-4111-8111-111111111111",
      env: "TOKEN",
    },
  });
  assert.equal(attached.statusCode, 403);
  assert.equal(attached.json().code, "APP_CREDENTIAL_ACCESS_FORBIDDEN");
  const message = await app.inject({
    method: "POST",
    url: `/agents/${agentId}/messages`,
    payload: { text: "Deploy my app with the slack credential." },
  });
  assert.equal(message.statusCode, 202);
  assert.deepEqual(sent, [
    `owner:${agentId}:Deploy my app with the slack credential.`,
  ]);
});

test("a teammate's deploy_app resolves its owner's credentials whoever asked it", async () => {
  const resolved: string[] = [];
  const workbench = new ArtifactWorkbench(
    {
      get: async () =>
        ({ credentialGeneration: 0 }) as unknown as ArtifactDetails,
      deploy: async () => ({ credentials: [] }) as unknown as ArtifactDetails,
    } as unknown as ArtifactGateway,
    {
      ...noCredentialGrants,
      resolve: async (ownerId) => {
        resolved.push(ownerId);
        return [];
      },
    },
  );
  // A teammate's tools carry only its owner; nothing records that an app sent the request.
  await workbench.deploy(
    {
      ownerId: "owner",
      author: { id: "agent", name: "Ada" },
      workspace: "/workspace/agent",
      shared: "/workspace/shared",
      privateDirectory: "/workspace/agent/.pi",
    },
    "my-app",
    { credentials: [{ name: "slack", env: "TOKEN" }] },
  );
  assert.deepEqual(resolved, ["owner"]);
});
