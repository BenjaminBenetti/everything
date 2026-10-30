import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
  everythingAppClaims,
  everythingAppClientId,
} from "@everything/artifact-contracts/everything-api";
import { createKeycloakTokenVerifier } from "@everything/security/keycloak";
import { ApiDocumentationService } from "../../api-documentation/service/api-documentation-service.js";
import {
  createHttpApplication,
  type HttpDependencies,
} from "../../application/factory/http-application.js";
import { appIdentity } from "../../identity/service/app-identity.js";
import { TelemetryQueryService } from "../../telemetry/service/telemetry-query-service.js";
import { HttpArtifactGateway } from "../adapter/http-artifact-gateway.js";
import { ArtifactLibraryService } from "../service/artifact-library-service.js";

import { noCredentialGrants } from "../../credential/test/credential-fixture.js";

const publicOrigin = "https://everything.test";
const issuer = `${publicOrigin}/auth/realms/everything`;
const audience = "everything-api";
const appId = "89bb2d67-090d-405a-84f8-880d9231c9c2";
const route = `/v1/artifacts/${appId}/visibility`;
const sessionCookie = "__Host-everything-session";

/** The signing key of the test identity provider; tokens are verified exactly as in production. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

/** Sign an RS256 access token, as Keycloak issues one, with the given client and extra claims. */
function accessToken(
  subject: string,
  client: string,
  claims: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${encode(
    {
      sub: subject,
      iss: issuer,
      aud: audience,
      azp: client,
      typ: "Bearer",
      iat: now,
      exp: now + 300,
      ...claims,
    },
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(privateKey)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

/** The owner's own sign-in token, which the browser session holds on the server. */
const ownerToken = accessToken("owner", "everything-web");
/** Another person's sign-in token. */
const otherToken = accessToken("other-owner", "everything-web");
/** A provisioned token of one of the owner's apps; it acts as the owner everywhere else. */
const appToken = accessToken(
  "service-account-app",
  everythingAppClientId(appId),
  {
    [everythingAppClaims.owner]: "owner",
    [everythingAppClaims.app]: appId,
  },
);
/** A test service account, such as the API suite's, which owns its own resources. */
const serviceToken = accessToken("service-account-bruno", "everything-bruno");

/** Any use of an unrelated dependency fails the test. */
function unusedOperations<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => () =>
        assert.fail(`Visibility tests invoked ${String(property)}`),
    },
  ) as T;
}

/** Serve the test provider's public key where the verifier fetches it, as Keycloak's JWKS does. */
async function keySet(context: TestContext): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        keys: [
          {
            ...publicKey.export({ format: "jwk" }),
            kid: "test-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/certs`;
}

/** The production HTTP application with real token verification, sessions, and gateway. */
async function application(context: TestContext) {
  const upstream: {
    url: string;
    method: string;
    body: string;
    actor: string;
  }[] = [];
  const gateway = new HttpArtifactGateway(
    {
      url: "http://artifact:8081",
      hostUrl: "http://artifact:8080",
      publicAppsHostUrl: "http://public-apps:8082",
    },
    { token: async () => "service-token" },
    async (url, init = {}) => {
      const headers = new Headers(init.headers);
      upstream.push({
        url: String(url),
        method: init.method ?? "GET",
        body: String(init.body ?? ""),
        actor: `${headers.get("x-everything-actor-id")}/${headers.get("x-everything-actor-name")}`,
      });
      if (String(url).includes("/owners/other-owner/"))
        return Response.json(
          { code: "ARTIFACT_NOT_FOUND", message: "App not found." },
          { status: 404 },
        );
      if (init.method === "GET") return Response.json({ artifacts: [] });
      const visibility = JSON.parse(String(init.body ?? "{}")).visibility;
      return Response.json({
        id: appId,
        slug: "planner",
        kind: "dynamic",
        title: "Planner",
        description: "",
        database: false,
        capabilities: [],
        credentials: [],
        credentialGeneration: 0,
        url: "https://artifacts.everything.test/planner/",
        publicUrl: "https://public-apps.everything.test/planner/",
        visibility: visibility ?? "private",
        status: "running",
        release: 2,
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
        createdBy: { id: "agent", name: "Ada" },
        updatedBy: { id: "owner", name: "You" },
        // Details the internal API returns that the browser never needs.
        deployment: { env: { SECRET_TOKEN: "upstream-secret" } },
        builds: [],
      });
    },
  );
  const dependencies: HttpDependencies = {
    apiDocumentation: new ApiDocumentationService(),
    verifier: createKeycloakTokenVerifier({
      issuer,
      audience,
      jwksUrl: await keySet(context),
      resolveIdentity: appIdentity,
    }),
    sessions: {
      ...unusedOperations<HttpDependencies["sessions"]>(),
      /** Browser sessions hold their person's own token on the server. */
      resolve: async (handle) =>
        handle === "owner-session"
          ? {
              accessToken: ownerToken,
              profile: { subject: "owner", displayName: "Owner" },
            }
          : handle === "other-session"
            ? {
                accessToken: otherToken,
                profile: { subject: "other-owner", displayName: "Other" },
              }
            : undefined,
    },
    publicOrigin,
    chatGptRedirectUri: "http://127.0.0.1:8080/v1/providers/chatgpt/callback",
    keys: unusedOperations(),
    credentialGrants: unusedOperations(),
    credentialRollouts: unusedOperations(),
    providers: unusedOperations(),
    models: unusedOperations(),
    agents: unusedOperations(),
    agentActivity: unusedOperations(),
    profiles: unusedOperations(),
    removal: unusedOperations(),
    conversations: unusedOperations(),
    attachments: unusedOperations(),
    subagents: unusedOperations(),
    updates: unusedOperations(),
    upgrades: unusedOperations(),
    artifacts: new ArtifactLibraryService(gateway, noCredentialGrants),
    workers: unusedOperations(),
    generalSettings: unusedOperations(),
    teammateOrder: unusedOperations(),
    workspaces: unusedOperations(),
    workspaceActivity: unusedOperations(),
    voice: unusedOperations(),
    voiceStreams: unusedOperations(),
    telemetry: new TelemetryQueryService(
      { enabled: false, retentionDays: 7 },
      null,
    ),
    readiness: async () => {},
  };
  const app = await createHttpApplication(dependencies);
  context.after(() => app.close());
  return { app, upstream };
}

/** A same-origin request from the signed-in owner's Apps screen. */
const browser = {
  cookie: `${sessionCookie}=owner-session`,
  origin: publicOrigin,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

test("the signed-in owner makes an app public and private from the browser, as themselves", async (context) => {
  const { app, upstream } = await application(context);
  for (const visibility of ["public", "private"] as const) {
    const response = await app.inject({
      method: "PUT",
      url: route,
      headers: {
        ...browser,
        // Authorship and ownership come from the session, never from the request.
        "x-everything-actor-id": "agent",
        "x-everything-actor-name": "Forged",
      },
      payload: { visibility },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json().visibility, visibility);
    assert.equal(
      response.json().url,
      "https://artifacts.everything.test/planner/",
    );
    assert.doesNotMatch(response.body, /upstream-secret|deployment|builds/);
  }
  assert.deepEqual(upstream, [
    {
      url: `http://artifact:8081/internal/v1/owners/owner/artifacts/${appId}/visibility`,
      method: "PUT",
      body: JSON.stringify({ visibility: "public" }),
      actor: "owner/You",
    },
    {
      url: `http://artifact:8081/internal/v1/owners/owner/artifacts/${appId}/visibility`,
      method: "PUT",
      body: JSON.stringify({ visibility: "private" }),
      actor: "owner/You",
    },
  ]);
});

test("app tokens acting as the same owner, other bearer tokens, and anonymous callers cannot change visibility", async (context) => {
  const { app, upstream } = await application(context);
  for (const [token, expected] of [
    [appToken, 403],
    [ownerToken, 403],
    [serviceToken, 403],
    ["not-a-token", 401],
  ] as const) {
    const response = await app.inject({
      method: "PUT",
      url: route,
      headers: {
        authorization: `Bearer ${token}`,
        origin: publicOrigin,
        "content-type": "application/json",
      },
      payload: { visibility: "public" },
    });
    assert.equal(response.statusCode, expected);
    if (expected === 403)
      assert.equal(response.json().code, "SIGNED_IN_USER_REQUIRED");
  }
  // A bearer token takes precedence over a browser session sent with it, so it cannot borrow one.
  const borrowed = await app.inject({
    method: "PUT",
    url: route,
    headers: { ...browser, authorization: `Bearer ${appToken}` },
    payload: { visibility: "public" },
  });
  assert.deepEqual(
    [borrowed.statusCode, borrowed.json().code],
    [403, "SIGNED_IN_USER_REQUIRED"],
  );
  const anonymous = await app.inject({
    method: "PUT",
    url: route,
    headers: { origin: publicOrigin, "content-type": "application/json" },
    payload: { visibility: "public" },
  });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(
    upstream.length,
    0,
    "no refused request reached the app service",
  );

  // The same app token still works where app tokens act as their owner, such as listing apps.
  const listed = await app.inject({
    url: "/v1/artifacts",
    headers: { authorization: `Bearer ${appToken}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(
    upstream.at(-1)?.url,
    "http://artifact:8081/internal/v1/owners/owner/artifacts",
  );
});

test("a signed-in browser cannot be made to change visibility from another origin, a GET, or an extra field", async (context) => {
  const { app, upstream } = await application(context);
  const attempts: Record<string, string>[] = [
    // An app page on the artifact origin, another site, or a sandboxed frame.
    {
      ...browser,
      origin: "https://artifacts.everything.test",
      "sec-fetch-site": "same-site",
    },
    { ...browser, origin: "https://evil.test", "sec-fetch-site": "cross-site" },
    { ...browser, origin: "null" },
    // A request that omits its origin, or claims the origin while the browser reports another site.
    (({ origin: _origin, ...rest }) => rest)(browser),
    { ...browser, "sec-fetch-site": "same-site" },
  ];
  for (const headers of attempts) {
    const response = await app.inject({
      method: "PUT",
      url: route,
      headers,
      payload: { visibility: "public" },
    });
    assert.equal(response.statusCode, 403, JSON.stringify(headers));
    assert.equal(response.json().code, "SESSION_ORIGIN_REJECTED");
  }
  for (const method of ["GET", "POST", "PATCH"] as const) {
    const response = await app.inject({
      method,
      url: route,
      headers: browser,
      ...(method === "GET" ? {} : { payload: { visibility: "public" } }),
    });
    assert.equal(response.statusCode, 404, method);
  }
  for (const payload of [
    { visibility: "public", ownerId: "owner" },
    { visibility: "everyone" },
    { public: true },
  ]) {
    const response = await app.inject({
      method: "PUT",
      url: route,
      headers: browser,
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  const notAnId = await app.inject({
    method: "PUT",
    url: "/v1/artifacts/planner/visibility",
    headers: browser,
    payload: { visibility: "public" },
  });
  assert.equal(notAnId.statusCode, 400);
  assert.deepEqual(upstream, []);
});

test("another person's session reaches only their own apps, where this one looks missing", async (context) => {
  const { app, upstream } = await application(context);
  const response = await app.inject({
    method: "PUT",
    url: route,
    headers: { ...browser, cookie: `${sessionCookie}=other-session` },
    payload: { visibility: "public" },
  });
  assert.deepEqual(
    [response.statusCode, response.json().code],
    [404, "ARTIFACT_NOT_FOUND"],
  );
  assert.deepEqual(
    upstream.map(({ url, actor }) => [url, actor]),
    [
      [
        `http://artifact:8081/internal/v1/owners/other-owner/artifacts/${appId}/visibility`,
        "other-owner/You",
      ],
    ],
  );
});
