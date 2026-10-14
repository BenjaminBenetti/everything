import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { FleetMcpDiscovery } from "../adapter/fleet-mcp-discovery.js";
import { fleetHome } from "../model/fleet-home.js";
import type { FleetMcpEndpoint } from "../model/fleet-mcp-endpoint.js";
import type { FleetConnectionSetup } from "../service/fleet-connection-setup.js";
import type { FleetDaemon } from "../service/fleet-daemon.js";
import { FleetHost } from "../service/fleet-host.js";
import type { FleetInstaller } from "../service/fleet-installer.js";

/** An empty Fleet home with its state directory, and a loopback port nothing listens on yet. */
async function fixture(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-mcp-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const home = fleetHome(directory);
  await mkdir(path.dirname(home.mcpPort), { recursive: true });
  const listener = createServer();
  context.after(() => listener.close());
  return { home, listener };
}

test("finds fleetd's MCP server once its port and token are published and the port accepts connections", async (context) => {
  const { home, listener } = await fixture(context);
  const found = new FleetMcpDiscovery(home).find();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const { port } = listener.address() as AddressInfo;
  await writeFile(home.mcpToken, "a".repeat(64) + "\n");
  await writeFile(home.mcpPort, `${port}\n`);
  assert.deepEqual(await found, {
    url: `http://127.0.0.1:${port}/`,
    token: "a".repeat(64),
  });
});

test("gives up on a token Pi would expand or a port nothing serves", async (context) => {
  const { home } = await fixture(context);
  await writeFile(home.mcpToken, "!cat /etc/passwd");
  await writeFile(home.mcpPort, "6012");
  await assert.rejects(new FleetMcpDiscovery(home, 300).find(), {
    message: "fleetd did not start its MCP server.",
  });
});

test("announces fleetd's MCP server to teammates once Fleet is up", async () => {
  const endpoint: FleetMcpEndpoint = {
    url: "http://127.0.0.1:6012/",
    token: "token",
  };
  const steps: string[] = [];
  /** A step of Fleet's startup that records when it runs. */
  const step = (name: string) => async () => {
    steps.push(name);
  };
  const host = new FleetHost(
    { install: step("install") } as unknown as FleetInstaller,
    {
      start: step("start"),
      close: step("close"),
    } as unknown as FleetDaemon,
    { apply: step("apply") } as unknown as FleetConnectionSetup,
    {
      /** fleetd's MCP server answers. */
      async find() {
        steps.push("find");
        return endpoint;
      },
    } as unknown as FleetMcpDiscovery,
    (error) => assert.fail(String(error)),
  );
  assert.equal(host.endpoint, undefined);
  host.start();
  assert.deepEqual(await host.whenRunning(), endpoint);
  assert.deepEqual(host.endpoint, endpoint);
  assert.deepEqual(steps, ["install", "start", "apply", "find"]);
  await host.close();
});
