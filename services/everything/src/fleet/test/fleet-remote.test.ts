import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fleetEnvironment, fleetHome } from "../model/fleet-home.js";
import {
  publishedGatewayAddress,
  withGatewayRemote,
} from "../model/fleet-remote.js";
import { FleetClientPublisher } from "../service/fleet-client-publisher.js";
import { FleetRemoteSetup } from "../service/fleet-remote-setup.js";

const gatewayUrl = "http://fleet-gateway.everything.svc.cluster.local:50051";
const sessionId = "a".repeat(64);
const address = `${gatewayUrl}/grpc/${sessionId}`;
const token = "0123456789abcdef".repeat(4);
const files = { address: "gateway-url", token: "token" };

/** A Fleet home in a temporary folder, removed after the test. */
async function home(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-remote-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, ".fleet"));
  return { directory, home: fleetHome(directory) };
}

/** A gateway session file as fleetd writes it, secrets included. */
function session(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "b".repeat(64),
    session_token: "header.claims.signature",
    public_url: "http://127.0.0.1:8080/mcp/" + sessionId,
    public_grpc_url: address,
    gateway_url: gatewayUrl,
    ...overrides,
  });
}

/** Wait for a condition the publisher reaches in the background. */
async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "the publisher did not catch up");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("turns on Remote Fleet through the gateway and keeps every other Fleet setting, Remote MCP included", () => {
  const config = {
    default_backend: "kubernetes",
    theme_settings: { name: "Gruvbox Dark" },
    remote_mcp_settings: {
      enabled: true,
      gateway_url: "https://old.example.com",
      fleet_mode: "ssh",
      webhook_enabled: true,
      image_registry_enabled: false,
    },
  };
  assert.deepEqual(withGatewayRemote(config, gatewayUrl), {
    default_backend: "kubernetes",
    theme_settings: { name: "Gruvbox Dark" },
    remote_mcp_settings: {
      enabled: true,
      gateway_url: gatewayUrl,
      fleet_mode: "gateway",
      webhook_enabled: true,
      image_registry_enabled: false,
      fleet_enabled: true,
    },
  });
  assert.deepEqual(withGatewayRemote({}, gatewayUrl), {
    remote_mcp_settings: {
      gateway_url: gatewayUrl,
      fleet_enabled: true,
      fleet_mode: "gateway",
    },
  });
  // Remote MCP stays off unless the user turned it on.
  assert.equal(
    "enabled" in
      (withGatewayRemote({}, gatewayUrl).remote_mcp_settings as object),
    false,
  );
});

test("publishes only a client address the configured gateway assigned to fleetd's session", () => {
  const parsed = JSON.parse(session()) as Record<string, unknown>;
  assert.equal(publishedGatewayAddress(parsed, gatewayUrl), address);
  for (const stale of [
    { ...parsed, gateway_url: "https://other.example.com" },
    { ...parsed, public_grpc_url: undefined },
    {
      ...parsed,
      public_grpc_url: `https://evil.example.com/grpc/${sessionId}`,
    },
    { ...parsed, public_grpc_url: `${gatewayUrl}/grpc/not-a-session` },
    { ...parsed, public_grpc_url: `${gatewayUrl}/grpc/${sessionId}/extra` },
    null,
    "text",
  ])
    assert.equal(publishedGatewayAddress(stale, gatewayUrl), undefined);
});

test("registers fleetd with the gateway before it starts, keeping its existing token and rewriting nothing that already matches", async (context) => {
  const { home: fleet } = await home(context);
  // The token fleetd generated long ago, which its MCP and remote clients already hold.
  await writeFile(fleet.mcpToken, `${token}\n`, { mode: 0o600 });
  await writeFile(
    fleet.config,
    JSON.stringify({ default_backend: "kubernetes" }),
  );
  const tokenBefore = await stat(fleet.mcpToken);
  const setup = new FleetRemoteSetup(fleet, { gatewayUrl });
  await setup.apply();
  assert.equal(await readFile(fleet.mcpToken, "utf8"), `${token}\n`);
  const tokenAfter = await stat(fleet.mcpToken);
  assert.deepEqual(
    [tokenAfter.mtimeMs, tokenAfter.ino],
    [tokenBefore.mtimeMs, tokenBefore.ino],
  );
  const config = JSON.parse(await readFile(fleet.config, "utf8"));
  assert.deepEqual(config, {
    default_backend: "kubernetes",
    remote_mcp_settings: {
      gateway_url: gatewayUrl,
      fleet_enabled: true,
      fleet_mode: "gateway",
    },
  });
  // A retry while fleetd runs must not touch files fleetd owns.
  const before = await stat(fleet.config);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await setup.apply();
  const after = await stat(fleet.config);
  assert.deepEqual([after.mtimeMs, after.ino], [before.mtimeMs, before.ino]);
});

test("leaves a fresh home's token to fleetd, which mints its own", async (context) => {
  const { home: fleet } = await home(context);
  await new FleetRemoteSetup(fleet, { gatewayUrl }).apply();
  await assert.rejects(stat(fleet.mcpToken), { code: "ENOENT" });
});

test("leaves fleetd's token and settings alone without a configured gateway", async (context) => {
  const { home: fleet } = await home(context);
  await writeFile(fleet.mcpToken, "existing");
  await new FleetRemoteSetup(fleet, undefined).apply();
  assert.equal(await readFile(fleet.mcpToken, "utf8"), "existing");
  await assert.rejects(stat(fleet.config), { code: "ENOENT" });
});

test("keeps every copy of settings fleetd cannot read in a recovery file of its own instead of failing to start Fleet", async (context) => {
  const { home: fleet } = await home(context);
  const setup = new FleetRemoteSetup(fleet, { gatewayUrl });
  const recoveries = async () =>
    (await readdir(path.dirname(fleet.config)))
      .filter((name) => name.startsWith("config.json.unreadable-"))
      .sort();
  await writeFile(fleet.config, "{ not json", { mode: 0o600 });
  await setup.apply();
  assert.deepEqual(JSON.parse(await readFile(fleet.config, "utf8")), {
    remote_mcp_settings: {
      gateway_url: gatewayUrl,
      fleet_enabled: true,
      fleet_mode: "gateway",
    },
  });
  // A second broken edit gets a recovery file of its own; the first one keeps its bytes.
  await writeFile(fleet.config, '{ "second": broken', { mode: 0o600 });
  await setup.apply();
  const kept = await recoveries();
  assert.equal(kept.length, 2);
  const contents = await Promise.all(
    kept.map((name) =>
      readFile(path.join(path.dirname(fleet.config), name), "utf8"),
    ),
  );
  assert.deepEqual(contents.sort(), ['{ "second": broken', "{ not json"]);
  for (const name of kept)
    assert.equal(
      (await stat(path.join(path.dirname(fleet.config), name))).mode & 0o777,
      0o600,
    );
});

test("publishes the session's client address, and only the address, for teammates and follows a change", async (context) => {
  const { directory, home: fleet } = await home(context);
  const folder = path.join(directory, "agents", ".fleet-client");
  const published = path.join(folder, "gateway-url");
  const failures: unknown[] = [];
  const publisher = new FleetClientPublisher(
    fleet,
    gatewayUrl,
    folder,
    files,
    (error) => failures.push(error),
    { pendingMs: 5, publishedMs: 5 },
  );
  await publisher.prepare();
  assert.equal((await stat(folder)).mode & 0o777, 0o755);
  publisher.start();
  context.after(() => publisher.close());
  // No session yet, then a session from another gateway, then a partial write: nothing is published.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await writeFile(
    fleet.gatewaySession,
    session({ gateway_url: "https://other.example.com" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await writeFile(fleet.gatewaySession, session().slice(0, 40));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(stat(published), { code: "ENOENT" });

  await writeFile(fleet.gatewaySession, session());
  await until(async () =>
    (await readFile(published, "utf8").catch(() => "")).includes(address),
  );
  const content = await readFile(published, "utf8");
  assert.equal(content, `${address}\n`);
  assert.ok(!content.includes("header.claims.signature"));
  assert.ok(!content.includes("b".repeat(64)));
  assert.equal((await stat(published)).mode & 0o777, 0o644);

  const changed = `${gatewayUrl}/grpc/${"c".repeat(64)}`;
  await writeFile(fleet.gatewaySession, session({ public_grpc_url: changed }));
  await until(
    async () => (await readFile(published, "utf8")) === `${changed}\n`,
  );
  // A session for another gateway withdraws the address rather than leaving a stale one.
  await writeFile(
    fleet.gatewaySession,
    session({ gateway_url: "https://other.example.com" }),
  );
  await until(async () =>
    stat(published).then(
      () => false,
      () => true,
    ),
  );
  await publisher.close();
  assert.deepEqual(failures, []);
});

test("keeps the client token and gateway address out of fleetd's environment", () => {
  const environment = fleetEnvironment(fleetHome("/fleet"), {
    PATH: "/usr/bin",
    FLEET_CLIENT_TOKEN: token,
    FLEET_GATEWAY_URL: gatewayUrl,
    FLEET_GATEWAY: address,
    FLEET_TOKEN: token,
  });
  assert.deepEqual(environment, { PATH: "/usr/bin", HOME: "/fleet" });
});

test("publishes fleetd's own token for teammates, private to their shared account, and follows a new one", async (context) => {
  const { directory, home: fleet } = await home(context);
  const folder = path.join(directory, "agents", ".fleet-client");
  const published = path.join(folder, "token");
  const failures: unknown[] = [];
  const publisher = new FleetClientPublisher(
    fleet,
    gatewayUrl,
    folder,
    files,
    (error) => failures.push(error),
    { pendingMs: 5, publishedMs: 5 },
  );
  await publisher.prepare();
  publisher.start();
  context.after(() => publisher.close());
  // Before fleetd has a token, nothing is published.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(stat(published), { code: "ENOENT" });
  await writeFile(fleet.mcpToken, `${token}\n`, { mode: 0o600 });
  await until(
    async () => (await readFile(published, "utf8").catch(() => "")) === token,
  );
  assert.equal((await stat(published)).mode & 0o777, 0o600);
  // The token stays fleetd's: publishing never writes to Fleet's home.
  assert.equal(await readFile(fleet.mcpToken, "utf8"), `${token}\n`);
  const replaced = "fedcba9876543210".repeat(4);
  await writeFile(fleet.mcpToken, replaced);
  await until(async () => (await readFile(published, "utf8")) === replaced);
  await rm(fleet.mcpToken);
  await until(async () =>
    stat(published).then(
      () => false,
      () => true,
    ),
  );
  await publisher.close();
  assert.deepEqual(failures, []);
});
