import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { requireAuthentication } from "@everything/security/fastify";
import { sessionController } from "../controller/session-controller.js";
import { SessionCookie } from "../handler/session-cookie.js";
import { errorHandler } from "../../http/handler/error-handler.js";
import { strictRequestValidation } from "../../http/config/request-validation.js";
import { sessionFixture } from "./session-fixture.js";

/** Use the production controller, session service, cookie policy, and authentication hook. */
async function server(origin = "https://app.test") {
  const f = sessionFixture();
  const app = Fastify({ ajv: strictRequestValidation });
  await app.register(fastifyCookie);
  await app.register(rateLimit, { global: false });
  app.setErrorHandler(errorHandler);
  const cookie = new SessionCookie(origin);
  await app.register(
    async (scope) => sessionController(scope, f.service, cookie),
    { prefix: "/v1" },
  );
  await app.register(async (scope) => {
    scope.addHook("onRequest", async (request) => {
      cookie.protectMutation(request);
    });
    requireAuthentication(
      scope,
      {
        /** Accept only the fixture's known access tokens. */
        async verify(token) {
          if (!token.startsWith("access-")) throw new Error("Invalid");
          return { subject: "owner" };
        },
      },
      async (request) =>
        (await f.service.resolve(cookie.read(request)))?.accessToken,
    );
    scope.get("/private", async (request) => request.identity);
    scope.post("/private", async (request) => request.identity);
  });
  return { app, ...f };
}

test("inline login returns only a profile, secure cookie and no-store; logout rejects replay", async (t) => {
  const { app } = await server();
  t.after(() => app.close());
  const login = await app.inject({
    method: "POST",
    url: "/v1/session",
    headers: { origin: "https://app.test" },
    payload: { username: "owner", password: "test" },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.deepEqual(login.json(), {
    profile: { subject: "owner", displayName: "Owner" },
  });
  assert.equal(login.headers["cache-control"], "no-store");
  const setCookie = String(login.headers["set-cookie"]);
  for (const flag of [
    "__Host-everything-session=",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
  ])
    assert.ok(setCookie.includes(flag));
  const cookie = setCookie.split(";")[0]!;
  assert.equal(
    (await app.inject({ url: "/private", headers: { cookie } })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: "/v1/session", headers: { cookie } })).json()
      .profile.subject,
    "owner",
  );
  assert.equal(
    (
      await app.inject({
        url: "/private",
        headers: { cookie, authorization: "bad-header" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/session/logout",
        headers: { cookie, origin: "https://app.test" },
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (await app.inject({ url: "/private", headers: { cookie } })).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: "/v1/session", headers: { cookie } })).json()
      .profile,
    null,
  );
});

test("rejects cross-site login, logout and cookie mutations while retaining bearer API access", async (t) => {
  const { app } = await server();
  t.after(() => app.close());
  for (const origin of [undefined, "https://evil.test", "null"]) {
    const headers = origin ? { origin } : {};
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/session",
          headers,
          payload: { username: "owner", password: "test" },
        })
      ).statusCode,
      403,
    );
  }
  const response = await app.inject({
    method: "POST",
    url: "/v1/session",
    headers: { origin: "https://app.test" },
    payload: { username: "owner", password: "test" },
  });
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  for (const url of ["/v1/session/logout", "/private"])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { cookie, origin: "https://evil.test" },
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/private",
        headers: { cookie, origin: "https://app.test" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/private",
        headers: { authorization: "Bearer access-api" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/private" })).statusCode,
    401,
  );
});

test("validates bounded JSON credentials and throttles password attempts", async (t) => {
  const { app } = await server("http://localhost:8080");
  t.after(() => app.close());
  for (const payload of [
    { username: " ", password: "x" },
    { username: "x", password: "" },
    { username: "x", password: "x".repeat(1025) },
    { username: "x", password: "x", extra: true },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/session",
      headers: { origin: "http://localhost:8080" },
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  let response;
  for (let i = 0; i < 21; i++)
    response = await app.inject({
      method: "POST",
      url: "/v1/session",
      headers: { origin: "http://localhost:8080" },
      payload: { username: "x", password: "x" },
    });
  assert.equal(response?.statusCode, 429);
});
