import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  requireAuthentication,
  subject,
} from "../handler/authentication-hook.js";
import type { TokenVerifier } from "../interface/token-verifier.js";

/** Mount a protected scope as a consuming service would, keeping health public. */
async function createService(
  verifier: TokenVerifier,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.get("/health", async () => ({ status: "ok" }));
  await app.register(async (protectedApi) => {
    requireAuthentication(protectedApi, verifier);
    protectedApi.get("/me", async (request) => ({ subject: subject(request) }));
  });
  return app;
}

test("rejects missing and malformed credentials before calling the verifier", async (context) => {
  let calls = 0;
  const app = await createService({
    /** Count accidental verifier calls made for malformed credentials. */
    async verify() {
      calls++;
      return { subject: "must-not-be-authenticated" };
    },
  });
  context.after(() => app.close());

  for (const authorization of [
    undefined,
    "Basic secret",
    "Bearer",
    "Bearer a b",
  ]) {
    const response = await app.inject({
      url: "/me",
      headers: authorization === undefined ? {} : { authorization },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(
      response.headers["www-authenticate"],
      'Bearer realm="everything"',
    );
    assert.deepEqual(response.json(), {
      code: "UNAUTHENTICATED",
      message: "A valid access token is required.",
    });
  }
  assert.equal(calls, 0);
});

test("uses the verified identity per request and fails closed without leaking verifier errors", async (context) => {
  const app = await createService({
    /** Authenticate a known credential and reject the simulated expired one. */
    async verify(token) {
      if (token === "expired") throw new Error("private signing-key detail");
      return { subject: token };
    },
  });
  context.after(() => app.close());

  assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
  for (const owner of ["owner-one", "owner-two"]) {
    const accepted = await app.inject({
      url: "/me",
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { subject: owner });

    const rejected = await app.inject({
      url: "/me",
      headers: { authorization: "Bearer expired" },
    });
    assert.equal(rejected.statusCode, 401);
    assert.deepEqual(rejected.json(), {
      code: "UNAUTHENTICATED",
      message: "A valid access token is required.",
    });
  }
});
