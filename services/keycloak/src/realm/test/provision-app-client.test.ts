import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FixtureClient, FixtureState } from "./kcadm-fixture.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "../script/provision-app-client.sh");
const fixture = path.join(here, "kcadm-fixture.ts");

const adminPassword = "fixture-admin-password-5f2c";
const provisionerSecret = "fixture-provisioner-secret-9d41";
const adminApiScope = "scope-kc-admin-api";
const ordinaryDefaults = [
  "scope-web-origins",
  "scope-acr",
  "scope-profile",
  "scope-roles",
  "scope-basic",
  "scope-email",
];
const ordinaryOptional = ["scope-address", "scope-phone", "scope-offline"];

// ===========================================
// Fixture
// ===========================================

/** The provisioner client as a realm created before Keycloak 26.8.2 holds it. */
function provisioner(overrides: Partial<FixtureClient> = {}): FixtureClient {
  return {
    id: "provisioner-uuid",
    clientId: "everything-app-provisioner",
    protocol: "openid-connect",
    publicClient: false,
    bearerOnly: false,
    serviceAccountsEnabled: true,
    defaultScopes: [...ordinaryDefaults],
    optionalScopes: [...ordinaryOptional],
    ...overrides,
  };
}

/** A realm with Keycloak's built-in scopes, the provisioner, and another client. */
function state(overrides: Partial<FixtureState> = {}): FixtureState {
  return {
    admin: { username: "admin", password: adminPassword },
    realms: {
      everything: {
        scopes: [
          ...[...ordinaryDefaults, ...ordinaryOptional].map((id) => ({
            id,
            name: id.replace(/^scope-/, ""),
            protocol: "openid-connect",
          })),
          { id: "scope-saml-roles", name: "role_list", protocol: "saml" },
          {
            id: adminApiScope,
            name: "kc-admin-api",
            protocol: "openid-connect",
          },
        ],
        clients: [
          provisioner(),
          {
            id: "web-uuid",
            clientId: "everything-web",
            protocol: "openid-connect",
            publicClient: false,
            bearerOnly: false,
            serviceAccountsEnabled: false,
            defaultScopes: [...ordinaryDefaults],
            optionalScopes: [...ordinaryOptional],
          },
        ],
        roles: {
          "service-account-everything-app-provisioner": [
            "realm-management/manage-clients",
          ],
        },
        sslRequired: "external",
      },
    },
    calls: [],
    ...overrides,
  };
}

/** A health endpoint that reports ready once `readyAfter` requests have been refused. */
async function healthServer(
  readyAfter = 0,
): Promise<{ server: Server; port: number; requests: () => number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const ready = request.url === "/health/ready" && requests > readyAfter;
    response.writeHead(ready ? 200 : 503).end();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return {
    server,
    port: (server.address() as AddressInfo).port,
    requests: () => requests,
  };
}

/** The outcome of one run of the script. */
interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  state: FixtureState;
  processLog: string;
  seconds: number;
}

/** Run the script against the fixture, as Keycloak's container runs it, with these arguments. */
async function run(
  initial: FixtureState,
  args: string[],
  options: {
    port?: number;
    env?: Record<string, string>;
    whileRunning?: (pid: number) => void;
  } = {},
): Promise<Run> {
  const directory = mkdtempSync(path.join(tmpdir(), "provision-app-client-"));
  const statePath = path.join(directory, "state.json");
  const cli = path.join(directory, "kcadm.sh");
  const processLog = path.join(directory, "keycloak.log");
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(cli, `#!/bin/sh\nexec node "${fixture}" "$@"\n`);
  chmodSync(cli, 0o755);
  writeFileSync(processLog, "");
  const started = Date.now();
  const child = spawn("bash", [script, ...args], {
    detached: true,
    env: {
      PATH: process.env.PATH,
      TMPDIR: directory,
      KCADM_FIXTURE_STATE: statePath,
      KEYCLOAK_ADMIN_CLI: cli,
      KEYCLOAK_PROCESS_LOG: processLog,
      KC_HTTP_MANAGEMENT_PORT: String(options.port ?? 9),
      EVERYTHING_REALM: "everything",
      KC_BOOTSTRAP_ADMIN_USERNAME: "admin",
      KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      EVERYTHING_APP_PROVISIONER_CLIENT_SECRET: provisionerSecret,
      ...options.env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  options.whileRunning?.(child.pid!);
  const [code, signal] = await new Promise<
    [number | null, NodeJS.Signals | null]
  >((resolve) => child.on("close", (c, s) => resolve([c, s])));
  return {
    code,
    signal,
    stdout,
    stderr,
    state: JSON.parse(readFileSync(statePath, "utf8")) as FixtureState,
    processLog: readFileSync(processLog, "utf8"),
    seconds: (Date.now() - started) / 1000,
  };
}

/** The calls that change something in Keycloak. */
function writes(result: Run): string[] {
  return result.state.calls
    .map((call) => call.args)
    .filter((args) =>
      ["update", "create", "delete", "add-roles"].includes(args[0]!),
    )
    .map((args) => args.slice(0, 2).join(" "));
}

/** The provisioner client after a run. */
function client(result: Run): FixtureClient {
  return result.state.realms.everything!.clients.find(
    (candidate) => candidate.clientId === "everything-app-provisioner",
  )!;
}

/** Nothing secret is printed, the credential cache was private, and it is gone afterwards. */
function assertCredentialsKept(result: Run): void {
  for (const output of [result.stdout, result.stderr, result.processLog]) {
    assert.ok(
      !output.includes(adminPassword),
      "the admin password is never printed",
    );
    assert.ok(
      !output.includes(provisionerSecret),
      "the client secret is never printed",
    );
  }
  for (const call of result.state.calls.slice(1))
    assert.equal(call.configMode, "600", "the credential cache is private");
  const paths = new Set(result.state.calls.map((call) => call.configPath));
  assert.equal(paths.size, 1, "one credential cache per run");
  for (const cache of paths)
    assert.ok(!existsSync(cache), "the credential cache is removed");
}

// ===========================================
// Scope only
// ===========================================

test("adds kc-admin-api to the provisioner's default scopes and changes nothing else", async () => {
  const health = await healthServer();
  try {
    const result = await run(state(), ["--admin-api-scope"], {
      port: health.port,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      /Added the kc-admin-api default client scope to everything-app-provisioner/,
    );
    assert.deepEqual(writes(result), [
      `update clients/provisioner-uuid/default-client-scopes/${adminApiScope}`,
    ]);
    assert.deepEqual(client(result).defaultScopes, [
      ...ordinaryDefaults,
      adminApiScope,
    ]);
    assert.deepEqual(client(result).optionalScopes, ordinaryOptional);
    const untouched = state().realms.everything!;
    assert.deepEqual(
      result.state.realms.everything!.clients[1],
      untouched.clients[1],
    );
    assert.deepEqual(result.state.realms.everything!.roles, untouched.roles);
    assert.equal(
      result.processLog,
      "",
      "only the hook copies messages to Keycloak's log",
    );
    assertCredentialsKept(result);

    const again = await run(
      { ...result.state, calls: [] },
      ["--admin-api-scope"],
      { port: health.port },
    );
    assert.equal(again.code, 0, again.stderr);
    assert.match(
      again.stderr,
      /already has the kc-admin-api default client scope/,
    );
    assert.deepEqual(writes(again), [], "a second run changes nothing");
    assert.deepEqual(again.state.realms, result.state.realms);
    assertCredentialsKept(again);
  } finally {
    health.server.close();
  }
});

test("refuses, without changing anything, when the names it needs are missing or ambiguous", async () => {
  const health = await healthServer();
  const cases: [string, FixtureState, RegExp][] = [
    [
      "no provisioner client",
      (() => {
        const s = state();
        s.realms.everything!.clients = s.realms.everything!.clients.slice(1);
        return s;
      })(),
      /has no single client everything-app-provisioner/,
    ],
    [
      "a public client of that name",
      (() => {
        const s = state();
        s.realms.everything!.clients[0] = provisioner({ publicClient: true });
        return s;
      })(),
      /is not a confidential OpenID Connect client with a service account/,
    ],
    [
      "no kc-admin-api scope",
      (() => {
        const s = state();
        s.realms.everything!.scopes = s.realms.everything!.scopes.filter(
          (x) => x.name !== "kc-admin-api",
        );
        return s;
      })(),
      /has no single OpenID Connect client scope named kc-admin-api/,
    ],
    [
      "a kc-admin-api scope of another protocol",
      (() => {
        const s = state();
        s.realms.everything!.scopes = s.realms.everything!.scopes.map((x) =>
          x.name === "kc-admin-api" ? { ...x, protocol: "saml" } : x,
        );
        return s;
      })(),
      /has no single OpenID Connect client scope named kc-admin-api/,
    ],
    [
      "two kc-admin-api scopes",
      (() => {
        const s = state();
        s.realms.everything!.scopes.push({
          id: "scope-copy",
          name: "kc-admin-api",
          protocol: "openid-connect",
        });
        return s;
      })(),
      /has no single OpenID Connect client scope named kc-admin-api/,
    ],
    [
      "kc-admin-api as an optional scope",
      (() => {
        const s = state();
        s.realms.everything!.clients[0] = provisioner({
          optionalScopes: [...ordinaryOptional, adminApiScope],
        });
        return s;
      })(),
      /has kc-admin-api as an optional client scope/,
    ],
    [
      "no such realm",
      state({ realms: {} }),
      /Could not look up everything-app-provisioner in realm everything/,
    ],
  ];
  try {
    for (const [name, initial, message] of cases) {
      const result = await run(initial, ["--admin-api-scope"], {
        port: health.port,
      });
      assert.equal(result.code, 1, name);
      assert.match(result.stderr, message, name);
      assert.match(result.stderr, /Nothing was changed\./, name);
      assert.deepEqual(writes(result), [], name);
      assert.deepEqual(result.state.realms, initial.realms, name);
      assertCredentialsKept(result);
    }
  } finally {
    health.server.close();
  }
});

test("signs in once and stops when the bootstrap administrator is refused", async () => {
  const health = await healthServer();
  try {
    const initial = state({
      admin: { username: "admin", password: "rotated-elsewhere" },
    });
    const result = await run(initial, ["--admin-api-scope"], {
      port: health.port,
    });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Keycloak refused the bootstrap administrator .*Invalid user credentials \[invalid_grant\]/,
    );
    assert.equal(
      result.state.calls.length,
      1,
      "no retry with refused credentials",
    );
    assert.ok(result.seconds < 10, `stopped after ${result.seconds}s`);
    assertCredentialsKept(result);
  } finally {
    health.server.close();
  }
});

test("accepts a scope another run added, and reports an update Keycloak ignored", async () => {
  const health = await healthServer();
  try {
    const raced = await run(
      state({ scopeUpdateRaced: true }),
      ["--admin-api-scope"],
      { port: health.port },
    );
    assert.equal(raced.code, 0, raced.stderr);
    assert.match(raced.stderr, /Added the kc-admin-api default client scope/);

    const ignored = await run(
      state({ scopeUpdateIgnored: true }),
      ["--admin-api-scope"],
      { port: health.port },
    );
    assert.equal(ignored.code, 1);
    assert.match(
      ignored.stderr,
      /Keycloak did not add the kc-admin-api default client scope/,
    );

    const refused = await run(
      state({ scopeUpdateError: "HTTP 403 Forbidden" }),
      ["--admin-api-scope"],
      { port: health.port },
    );
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /HTTP 403 Forbidden/);
    assert.match(
      refused.stderr,
      /Keycloak did not add the kc-admin-api default client scope/,
    );
    assert.deepEqual(client(refused).defaultScopes, ordinaryDefaults);
  } finally {
    health.server.close();
  }
});

test("waits for the server to become ready, within a bound", async () => {
  const health = await healthServer(2);
  try {
    const result = await run(state(), ["--admin-api-scope"], {
      port: health.port,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(health.requests() >= 3, "it asked until the server was ready");
  } finally {
    health.server.close();
  }

  const never = await healthServer(Number.MAX_SAFE_INTEGER);
  try {
    const result = await run(state(), ["--admin-api-scope"], {
      port: never.port,
      env: { ADMIN_API_SCOPE_READY_SECONDS: "3" },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Keycloak was not ready within 3s/);
    assert.equal(
      result.state.calls.length,
      0,
      "no admin call before the server is ready",
    );
    assert.ok(result.seconds < 15, `stopped after ${result.seconds}s`);
  } finally {
    never.server.close();
  }
});

// ===========================================
// Startup hook
// ===========================================

test("as the postStart hook, reports a configuration problem in Keycloak's log and keeps it running", async () => {
  const health = await healthServer();
  try {
    const added = await run(state(), ["--admin-api-scope", "--post-start"], {
      port: health.port,
    });
    assert.equal(added.code, 0, added.stderr);
    assert.match(
      added.processLog,
      /Added the kc-admin-api default client scope/,
    );

    const refused = await run(
      state({ admin: { username: "admin", password: "removed" } }),
      ["--admin-api-scope", "--post-start"],
      {
        port: health.port,
      },
    );
    assert.equal(
      refused.code,
      0,
      "a configuration problem never restarts Keycloak",
    );
    assert.equal(
      refused.state.calls.length,
      1,
      "no retry with refused credentials",
    );
    assert.match(
      refused.processLog,
      /Keycloak refused the bootstrap administrator/,
    );
    assert.match(
      refused.processLog,
      /Keycloak keeps running; fix the cause above, then restart Keycloak\./,
    );
    assertCredentialsKept(refused);

    const unset = await run(state(), ["--admin-api-scope", "--post-start"], {
      port: health.port,
      env: { EVERYTHING_REALM: "" },
    });
    assert.equal(unset.code, 0);
    assert.match(unset.processLog, /EVERYTHING_REALM names no realm/);
    assert.equal(unset.state.calls.length, 0);
  } finally {
    health.server.close();
  }

  const never = await healthServer(Number.MAX_SAFE_INTEGER);
  try {
    const result = await run(state(), ["--admin-api-scope", "--post-start"], {
      port: never.port,
      env: { ADMIN_API_SCOPE_READY_SECONDS: "3" },
    });
    assert.equal(
      result.code,
      1,
      "a server that never becomes ready fails the hook",
    );
    assert.match(result.processLog, /Keycloak was not ready within 3s/);
    assert.match(result.stderr, /Keycloak was not ready within 3s/);

    // Run as the container's first process, the process log is its own output: no copy, no loop.
    const own = await run(state(), ["--admin-api-scope", "--post-start"], {
      port: never.port,
      env: {
        ADMIN_API_SCOPE_READY_SECONDS: "3",
        KEYCLOAK_PROCESS_LOG: "/dev/stderr",
      },
    });
    assert.equal(own.code, 1);
    assert.equal(
      own.stderr.match(/Keycloak was not ready within 3s/g)?.length,
      1,
    );
  } finally {
    never.server.close();
  }
});

test("removes the credential cache when stopped mid-call", async () => {
  const health = await healthServer();
  try {
    const result = await run(state({ hang: "get" }), ["--admin-api-scope"], {
      port: health.port,
      whileRunning: (pid) =>
        setTimeout(() => process.kill(-pid, "SIGTERM"), 3000),
    });
    assert.ok(
      result.code === 143 || result.signal === "SIGTERM",
      `stopped: ${result.code} ${result.signal}`,
    );
    assert.ok(result.state.calls.length >= 2, "it was signed in when stopped");
    assertCredentialsKept(result);
  } finally {
    health.server.close();
  }
});

// ===========================================
// Full provisioning
// ===========================================

test("the full provisioning keeps its steps and adds the scope", async () => {
  const result = await run(state(), []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "App API client provisioning is ready.\n");
  assert.deepEqual(writes(result), [
    "update clients/provisioner-uuid",
    "add-roles -r",
    `update clients/provisioner-uuid/default-client-scopes/${adminApiScope}`,
    "update realms/everything",
  ]);
  assert.equal(client(result).secret, provisionerSecret);
  assert.deepEqual(client(result).defaultScopes, [
    ...ordinaryDefaults,
    adminApiScope,
  ]);
  assertCredentialsKept(result);

  const created = state();
  created.realms.everything!.clients =
    created.realms.everything!.clients.slice(1);
  const fresh = await run(created, []);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.deepEqual(writes(fresh).slice(0, 2), [
    "create clients",
    "update clients/created-1",
  ]);
  assert.ok(client(fresh).defaultScopes.includes(adminApiScope));

  const refused = await run(state({ scopeUpdateIgnored: true }), []);
  assert.equal(
    refused.code,
    1,
    "the full provisioning fails when the scope cannot be added",
  );
  assert.ok(!refused.stdout.includes("ready"));
});

test("rejects unknown arguments", async () => {
  for (const args of [["--everything"], ["--post-start"]]) {
    const result = await run(state(), args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.state.calls.length, 0);
  }
});
