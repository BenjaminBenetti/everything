import assert from "node:assert/strict";
import { test } from "node:test";
import {
  everythingAppClaims,
  everythingAppClientId,
} from "@everything/artifact-contracts/everything-api";
import { KeycloakAppApiClients } from "../adapter/keycloak-app-api-clients.js";

const appId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

/** A stored protocol mapper, as Keycloak returns it. */
interface StoredMapper {
  id?: string;
  name: string;
  protocol: string;
  protocolMapper: string;
  config: Record<string, string>;
}

/** How the fixture's Keycloak differs from an unrestricted one. */
interface FixtureOptions {
  /** Keycloak 26.8.2: only realm administrators may create or change mappers. */
  readonly restricted?: boolean;
  /** Another provisioner creates the client first, so this one's create gets 409. */
  readonly concurrent?: boolean;
  /** An update that omits the mappers deletes them, unlike Keycloak. */
  readonly updateDropsMappers?: boolean;
}

/**
 * Model Keycloak's client lifecycle, retaining secrets independently of PUT representations. Stored
 * mappers get IDs, and Keycloak fills in `userinfo.token.claim` from `id.token.claim`; an update
 * keeps the mappers when it omits them, and replaces them when it sends them.
 */
function fixture(options: FixtureOptions = {}) {
  let stored: Record<string, unknown> | undefined;
  let generation = 0;
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  /** Store mappers the way Keycloak does. */
  const store = (mappers: StoredMapper[]): StoredMapper[] =>
    mappers.map((mapper, index) => ({
      ...mapper,
      id: `mapper-${index}`,
      config: {
        "userinfo.token.claim": mapper.config["id.token.claim"] ?? "false",
        ...mapper.config,
      },
    }));
  const create = (body: Record<string, unknown>) => {
    stored = {
      ...body,
      id: "client-uuid",
      protocolMappers: store((body.protocolMappers as StoredMapper[]) ?? []),
    };
    generation++;
  };
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
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (options.restricted && body.protocolMappers)
        return new Response(null, { status: 403 });
      if (options.concurrent) {
        create(body);
        return new Response(null, { status: 409 });
      }
      create(body);
      return new Response(null, { status: 201 });
    }
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (options.restricted && body.protocolMappers !== undefined)
        return new Response(null, { status: 403 });
      stored = {
        ...body,
        id: "client-uuid",
        protocolMappers:
          body.protocolMappers !== undefined
            ? store(body.protocolMappers as StoredMapper[])
            : options.updateDropsMappers
              ? []
              : stored?.protocolMappers,
      };
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/client-secret"))
      return Response.json({ value: `app-secret-${generation}` });
    if (method === "GET" && url.pathname.endsWith("/clients/client-uuid"))
      return stored
        ? Response.json(stored)
        : new Response(null, { status: 404 });
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
  return {
    clients,
    calls,
    bodies,
    stored: () => stored,
    /** A client an earlier version created, before Keycloak restricted mappers. */
    provisioned: (owner: string) => {
      const legacy = fixture();
      return legacy.clients.ensure(appId, owner).then(() => {
        stored = structuredClone(legacy.stored());
        generation = 1;
      });
    },
  };
}

/** The calls that change a client or read its secret. */
function sensitive(calls: readonly string[]): string[] {
  return calls.filter(
    (call) => !call.startsWith("GET ") || call.endsWith("/client-secret"),
  );
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

test("an existing client is repaired without sending its mappers, which Keycloak 26.8.2 lets only realm administrators change", async () => {
  const f = fixture({ restricted: true });
  await f.provisioned("owner");
  const before = structuredClone(f.stored()!.protocolMappers);
  const first = await f.clients.ensure(appId, "owner");
  assert.deepEqual(first, {
    clientId: everythingAppClientId(appId),
    clientSecret: "app-secret-1",
  });
  assert.deepEqual(await f.clients.ensure(appId, "owner"), first);
  // Only updates without mappers, so the stored mappers, IDs included, are exactly as they were.
  assert.equal(f.bodies.length, 2);
  for (const body of f.bodies) {
    assert.equal(Object.hasOwn(body, "protocolMappers"), false);
    assert.equal(body.serviceAccountsEnabled, true);
    assert.equal(body.fullScopeAllowed, false);
    assert.deepEqual(body.attributes, {
      [everythingAppClaims.app]: appId,
      [everythingAppClaims.owner]: "owner",
      "access.token.lifespan": "300",
      "client_credentials.use_refresh_token": "false",
    });
  }
  assert.deepEqual(f.stored()!.protocolMappers, before);
  // Each repair reads the client's mappers before the update and again before reading the secret.
  assert.deepEqual(f.calls.slice(0, 5), [
    "GET /auth/admin/realms/everything/clients",
    "GET /auth/admin/realms/everything/clients/client-uuid",
    "PUT /auth/admin/realms/everything/clients/client-uuid",
    "GET /auth/admin/realms/everything/clients/client-uuid",
    "GET /auth/admin/realms/everything/clients/client-uuid/client-secret",
  ]);
  await assert.rejects(f.clients.ensure(appId, "other-owner"), {
    message: "The app client does not belong to this app and owner",
  });
});

test("a new client still needs Keycloak's permission to create its mappers", async () => {
  const f = fixture({ restricted: true });
  await assert.rejects(f.clients.ensure(appId, "owner"), {
    message: "The identity provider refused app client provisioning (403)",
  });
  assert.equal(f.stored(), undefined);
  assert.deepEqual(sensitive(f.calls), [
    "POST /auth/admin/realms/everything/clients",
  ]);
});

test("a client another provisioner created at the same time is repaired like any other", async () => {
  const f = fixture({ concurrent: true });
  const client = await f.clients.ensure(appId, "owner");
  assert.equal(client.clientSecret, "app-secret-1");
  assert.deepEqual(sensitive(f.calls), [
    "POST /auth/admin/realms/everything/clients",
    "PUT /auth/admin/realms/everything/clients/client-uuid",
    "GET /auth/admin/realms/everything/clients/client-uuid/client-secret",
  ]);
});

test("a client whose mappers changed is refused before any change or secret", async () => {
  type Mappers = StoredMapper[];
  const claim = (mappers: Mappers, name: string) =>
    mappers.find((mapper) => mapper.name === name)!;
  const changes: [string, (mappers: Mappers) => unknown][] = [
    [
      "another owner",
      (m) =>
        (claim(m, everythingAppClaims.owner).config["claim.value"] =
          "intruder"),
    ],
    [
      "another app",
      (m) =>
        (claim(m, everythingAppClaims.app).config["claim.value"] =
          "another-app"),
    ],
    [
      "another audience",
      (m) =>
        (claim(m, "Everything API audience").config[
          "included.custom.audience"
        ] = "everything-artifact"),
    ],
    [
      "a claim also in ID tokens",
      (m) =>
        (claim(m, everythingAppClaims.owner).config["id.token.claim"] = "true"),
    ],
    [
      "a claim left out of introspection",
      (m) =>
        (claim(m, everythingAppClaims.app).config["introspection.token.claim"] =
          "false"),
    ],
    [
      "an extra setting",
      (m) =>
        (claim(m, everythingAppClaims.app).config["lightweight.claim"] =
          "true"),
    ],
    [
      "another mapper type",
      (m) =>
        (claim(m, everythingAppClaims.owner).protocolMapper =
          "oidc-usermodel-attribute-mapper"),
    ],
    [
      "another protocol",
      (m) => (claim(m, everythingAppClaims.owner).protocol = "saml"),
    ],
    ["a missing mapper", (m) => m.splice(0, 1)],
    [
      "an extra mapper",
      (m) =>
        m.push({
          name: "realm roles",
          protocol: "openid-connect",
          protocolMapper: "oidc-usermodel-realm-role-mapper",
          config: { "claim.name": "roles" },
        }),
    ],
    ["a repeated mapper", (m) => m.splice(2, 1, structuredClone(m[1]!))],
    [
      "a mapper without settings",
      (m) =>
        ((claim(m, everythingAppClaims.app) as { config?: unknown }).config =
          undefined),
    ],
    ["no mappers listed", (m) => m.splice(0)],
  ];
  for (const [change, apply] of changes) {
    const f = fixture({ restricted: true });
    await f.provisioned("owner");
    apply(f.stored()!.protocolMappers as Mappers);
    const drifted = structuredClone(f.stored());
    await assert.rejects(
      f.clients.ensure(appId, "owner"),
      { message: "The app client's token claims do not match this app" },
      change,
    );
    assert.deepEqual(sensitive(f.calls), [], change);
    assert.deepEqual(f.stored(), drifted, change);
  }
});

test("Keycloak's own stored defaults are accepted, and an update that loses the mappers keeps the secret", async () => {
  const f = fixture({ restricted: true });
  await f.provisioned("owner");
  for (const mapper of f.stored()!.protocolMappers as StoredMapper[])
    mapper.config["introspection.token.claim"] = "true";
  assert.equal(
    (await f.clients.ensure(appId, "owner")).clientSecret,
    "app-secret-1",
  );

  const dropping = fixture({ updateDropsMappers: true });
  await dropping.provisioned("owner");
  await assert.rejects(dropping.clients.ensure(appId, "owner"), {
    message: "The app client's token claims do not match this app",
  });
  assert.equal(
    dropping.calls.some((call) => call.endsWith("/client-secret")),
    false,
  );
});
