import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { FleetMcpDiscovery } from "../adapter/fleet-mcp-discovery.js";
import { fleetEnvironment, fleetHome } from "../model/fleet-home.js";
import { FleetClientPublisher } from "../service/fleet-client-publisher.js";
import { FleetDaemon } from "../service/fleet-daemon.js";
import { FleetRemoteSetup } from "../service/fleet-remote-setup.js";

/** The pinned Fleet release binary; without it these tests are skipped. */
const binary = process.env.FLEET_E2E_BINARY;
const skip = binary
  ? false
  : "set FLEET_E2E_BINARY to the pinned Fleet binary to run fleetd's authentication through Everything's setup";
/** A gateway nobody listens on: fleetd keeps trying to register, which these tests don't need. */
const gatewayUrl = "http://127.0.0.1:9";

/**
 * A disposable Fleet home with Everything's remote setup, fleetd supervisor, and client publisher
 * around the real pinned fleetd, as Everything's container runs them each time it starts.
 */
async function everything(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-auth-"));
  const home = fleetHome(directory);
  const folder = path.join(directory, "agents", ".fleet-client");
  const failures: unknown[] = [];
  let daemon: FleetDaemon | undefined;
  let publisher: FleetClientPublisher | undefined;
  /** Stop fleetd and the publisher, as replacing Everything's pod does. */
  const stop = async () => {
    await publisher?.close();
    await daemon?.close();
    publisher = daemon = undefined;
  };
  context.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  /** fleetd's MCP endpoint once it serves, with the token it published in its home. */
  const start = async (remote: boolean) => {
    if (remote) await new FleetRemoteSetup(home, { gatewayUrl }).apply();
    daemon = new FleetDaemon(
      binary!,
      fleetEnvironment(home, { PATH: process.env.PATH }),
      home.socket,
      (error) => failures.push(error),
    );
    await daemon.start();
    if (remote) {
      publisher = new FleetClientPublisher(
        home,
        gatewayUrl,
        folder,
        { address: "gateway-url", token: "token" },
        (error) => failures.push(error),
        { pendingMs: 50, publishedMs: 50 },
      );
      await publisher.prepare();
      publisher.start();
    }
    return (await new FleetMcpDiscovery(home).find()).url;
  };
  /** The token Everything published for teammates, once it has. */
  const published = async () => {
    const file = path.join(folder, "token");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const content = await readFile(file, "utf8").catch(() => "");
      if (content) return content;
      assert.ok(Date.now() < deadline, "the token was not published");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { home, failures, start, stop, published };
}

/** The status of an authenticated MCP initialize request, as fleetd's MCP and remote clients send. */
async function initialize(url: string, token: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "everything-test", version: "1" },
      },
    }),
  });
  await response.body?.cancel();
  return response.status;
}

test(
  "an existing Fleet home keeps its token through Everything's gateway setup and restarts, and teammates receive that same token",
  { skip, timeout: 120_000 },
  async (context) => {
    const fleet = await everything(context);
    // Before the integration: fleetd's existing token, which its clients already hold, works.
    const existing = randomBytes(32).toString("hex");
    await mkdir(path.dirname(fleet.home.mcpToken), { recursive: true });
    await writeFile(fleet.home.mcpToken, existing, { mode: 0o600 });
    const before = await fleet.start(false);
    assert.equal(await initialize(before, existing), 200);
    await fleet.stop();

    // With the integration, through two of Everything's starts: still the same token everywhere.
    for (let start = 0; start < 2; start++) {
      const url = await fleet.start(true);
      assert.equal(await initialize(url, existing), 200);
      assert.equal(await initialize(url, "0".repeat(64)), 401);
      assert.equal(await readFile(fleet.home.mcpToken, "utf8"), existing);
      assert.equal(await fleet.published(), existing);
      await fleet.stop();
    }
    assert.deepEqual(fleet.failures, []);
  },
);

test(
  "a fresh Fleet home gets the token fleetd mints, which teammates receive and which survives restarts",
  { skip, timeout: 120_000 },
  async (context) => {
    const fleet = await everything(context);
    const url = await fleet.start(true);
    const minted = await fleet.published();
    assert.match(minted, /^[0-9a-f]{64}$/);
    assert.equal((await readFile(fleet.home.mcpToken, "utf8")).trim(), minted);
    assert.equal(await initialize(url, minted), 200);
    await fleet.stop();
    const restarted = await fleet.start(true);
    assert.equal(await initialize(restarted, minted), 200);
    assert.equal(await fleet.published(), minted);
    assert.deepEqual(fleet.failures, []);
  },
);
