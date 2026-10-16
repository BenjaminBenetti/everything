import assert from "node:assert/strict";
import { test } from "node:test";
import {
  everythingAppClaims,
  everythingAppClientId,
} from "@everything/artifact-contracts/everything-api";
import { KeycloakAppApiClients } from "../adapter/keycloak-app-api-clients.js";

const appId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

/** Model Keycloak's client lifecycle, retaining secrets independently of PUT representations. */
function fixture() {
  let stored: Record<string, unknown> | undefined;
  let generation = 0;
  const calls: string[] = [];
  /** Accept only management-authenticated calls and implement the admin resource contract. */
  const fetcher = (async (input, init) => {
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer management-token",
    );
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (method === "GET" && url.search)
      return Response.json(stored ? [stored] : []);
    if (method === "POST") {
      stored = { ...JSON.parse(String(init?.body)), id: "client-uuid" };
      generation++;
      return new Response(null, { status: 201 });
    }
    if (method === "PUT") {
      stored = { ...JSON.parse(String(init?.body)), id: "client-uuid" };
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/client-secret"))
      return Response.json({ value: `app-secret-${generation}` });
    if (method === "DELETE") {
      stored = undefined;
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected admin request");
  }) as typeof fetch;
  const clients = new KeycloakAppApiClients(
    { token: async () => "management-token" },
    {
      adminUrl: "http://keycloak/auth/admin/realms/everything",
      audience: "everything-api",
    },
    fetcher,
  );
  return { clients, calls, stored: () => stored };
}

test("provisioning is idempotent, keeps app credentials stable, and restricts tokens to the API audience", async () => {
  const f = fixture();
  const first = await f.clients.ensure(appId, "owner");
  assert.deepEqual(first, {
    clientId: everythingAppClientId(appId),
    clientSecret: "app-secret-1",
  });
  assert.deepEqual(await f.clients.ensure(appId, "owner"), first);
  assert.equal(f.calls.filter((call) => call.startsWith("POST ")).length, 1);
  const definition = f.stored()!;
  assert.equal(definition.serviceAccountsEnabled, true);
  for (const flag of [
    "publicClient",
    "standardFlowEnabled",
    "implicitFlowEnabled",
    "directAccessGrantsEnabled",
    "fullScopeAllowed",
  ])
    assert.equal(definition[flag], false);
  assert.deepEqual(definition.optionalClientScopes, []);
  assert.equal(definition.secret, undefined);
  const mappers = definition.protocolMappers as {
    protocolMapper: string;
    config: Record<string, string>;
  }[];
  assert.equal(
    mappers.find((mapper) => mapper.protocolMapper === "oidc-audience-mapper")
      ?.config["included.custom.audience"],
    "everything-api",
  );
  for (const [claim, value] of [
    [everythingAppClaims.owner, "owner"],
    [everythingAppClaims.app, appId],
  ]) {
    const mapper = mappers.find(
      (mapper) => mapper.config["claim.name"] === claim,
    )!;
    assert.equal(mapper.config["claim.value"], value);
    assert.equal(mapper.config["access.token.claim"], "true");
  }
  await f.clients.remove(appId);
  await f.clients.remove(appId);
  assert.equal(f.calls.filter((call) => call.startsWith("DELETE ")).length, 1);
  assert.notEqual(
    (await f.clients.ensure(appId, "owner")).clientSecret,
    first.clientSecret,
  );
});

test("existing client ownership cannot be changed or adopted", async () => {
  const f = fixture();
  await f.clients.ensure(appId, "owner");
  const writes = f.calls.filter((call) => call.startsWith("PUT ")).length;
  await assert.rejects(f.clients.ensure(appId, "other-owner"));
  assert.equal(
    f.calls.filter((call) => call.startsWith("PUT ")).length,
    writes,
  );
  f.stored()!.attributes = {};
  await assert.rejects(f.clients.remove(appId));
  await assert.rejects(f.clients.ensure(appId, "owner"));
  assert.equal(
    f.calls.some((call) => call.startsWith("DELETE ")),
    false,
  );
});

test("provider failures never expose credentials from response bodies", async () => {
  const clients = new KeycloakAppApiClients(
    { token: async () => "management-secret" },
    {
      adminUrl: "http://keycloak/auth/admin/realms/everything",
      audience: "everything-api",
    },
    async () => Response.json({ secret: "sensitive-value" }, { status: 403 }),
  );
  await assert.rejects(clients.ensure(appId, "owner"), {
    message: "The identity provider refused app client provisioning (403)",
  });
});
