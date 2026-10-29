import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpArtifactGateway } from "../adapter/http-artifact-gateway.js";
import { ArtifactLibraryService } from "../service/artifact-library-service.js";
import { artifactController } from "../controller/artifact-controller.js";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { noCredentialGrants } from "../../credential/test/credential-fixture.js";

const appId = "89bb2d67-090d-405a-84f8-880d9231c9c2";

test("browser actions derive ownership and authorship from authentication and require stopped deletion", async (context) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const gateway = new HttpArtifactGateway(
    {
      url: "http://artifact:8081",
      hostUrl: "http://artifact:8080",
      publicAppsHostUrl: "http://public-apps:8082",
    },
    { token: async () => "service-token" },
    async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: appId });
    },
  );
  const server = authenticatedTestServer();
  context.after(() => server.close());
  await artifactController(
    server,
    new ArtifactLibraryService(gateway, noCredentialGrants),
    () => assert.fail("no signed-in-only route requested"),
  );
  for (const action of ["start", "stop", "delete"] as const) {
    const response = await server.inject({
      method: action === "delete" ? "DELETE" : "POST",
      url: `/artifacts/${appId}${action === "delete" ? "" : `/${action}`}`,
      headers: {
        "x-everything-actor-id": "someone-else",
        "x-everything-actor-name": "Forged",
      },
    });
    assert.equal(response.statusCode, 204);
  }
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      `http://artifact:8081/internal/v1/owners/owner/artifacts/${appId}/start`,
      `http://artifact:8081/internal/v1/owners/owner/artifacts/${appId}/stop`,
      `http://artifact:8081/internal/v1/owners/owner/artifacts/${appId}?requireStopped=true`,
    ],
  );
  for (const request of requests) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("x-everything-actor-id"), "owner");
    assert.equal(headers.get("x-everything-actor-name"), "You");
    assert.equal(headers.get("authorization"), "Bearer service-token");
  }
  assert.equal(
    (await server.inject({ method: "POST", url: "/artifacts/not-an-id/start" }))
      .statusCode,
    400,
  );
  assert.equal(requests.length, 3);
});

test("manual action errors keep missing apps opaque and translate conflicts without leaking upstream details", async (context) => {
  let status = 404;
  const gateway = new HttpArtifactGateway(
    {
      url: "http://artifact:8081",
      hostUrl: "http://artifact:8080",
      publicAppsHostUrl: "http://public-apps:8082",
    },
    { token: async () => "service-token" },
    async () =>
      Response.json(
        { code: "UPSTREAM", message: "private detail" },
        { status },
      ),
  );
  const server = authenticatedTestServer();
  context.after(() => server.close());
  await artifactController(
    server,
    new ArtifactLibraryService(gateway, noCredentialGrants),
    () => assert.fail("no signed-in-only route requested"),
  );
  for (const [upstream, expected, code] of [
    [404, 404, "ARTIFACT_NOT_FOUND"],
    [409, 409, "APP_ACTION_CONFLICT"],
    [500, 503, "ARTIFACTS_UNAVAILABLE"],
  ] as const) {
    status = upstream;
    const response = await server.inject({
      method: "DELETE",
      url: `/artifacts/${appId}`,
    });
    assert.equal(response.statusCode, expected);
    assert.equal(response.json().code, code);
    assert.doesNotMatch(response.body, /private detail/);
  }
});

test("the owner's API key is read from the app service for that owner and is never cached", async (context) => {
  const apiKey = `everything_app_key_${"k".repeat(43)}`;
  const requests: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const gateway = new HttpArtifactGateway(
    {
      url: "http://artifact:8081",
      hostUrl: "http://artifact:8080",
      publicAppsHostUrl: "http://public-apps:8082",
    },
    { token: async () => "service-token" },
    async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return status === 200
        ? Response.json({ apiKey })
        : Response.json(
            { code: "UPSTREAM", message: "private detail" },
            { status },
          );
    },
  );
  const server = authenticatedTestServer();
  context.after(() => server.close());
  await artifactController(
    server,
    new ArtifactLibraryService(gateway, noCredentialGrants),
    () => assert.fail("no signed-in-only route requested"),
  );
  const revealed = await server.inject({ url: `/artifacts/${appId}/api-key` });
  assert.equal(revealed.statusCode, 200);
  assert.equal(revealed.headers["cache-control"], "no-store");
  assert.deepEqual(revealed.json(), { apiKey });
  assert.deepEqual(
    requests.map((request) => [request.url, request.init.method ?? "GET"]),
    [
      [
        `http://artifact:8081/internal/v1/owners/owner/artifacts/${appId}/api-key`,
        "GET",
      ],
    ],
  );
  for (const [upstream, expected, code] of [
    [404, 404, "ARTIFACT_NOT_FOUND"],
    [409, 409, "APP_API_KEY_UNAVAILABLE"],
    [500, 503, "ARTIFACTS_UNAVAILABLE"],
  ] as const) {
    status = upstream;
    const response = await server.inject({
      url: `/artifacts/${appId}/api-key`,
    });
    assert.equal(response.statusCode, expected);
    assert.equal(response.json().code, code);
    assert.doesNotMatch(response.body, /private detail|everything_app_key_/);
  }
  assert.equal(
    (await server.inject({ url: "/artifacts/not-an-id/api-key" })).statusCode,
    400,
  );
  assert.equal(requests.length, 4);
});
