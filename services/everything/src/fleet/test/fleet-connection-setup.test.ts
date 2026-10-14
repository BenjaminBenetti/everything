import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { FleetCommands } from "../interface/fleet-commands.js";
import type { ConnectionRecord } from "../model/fleet-connection.js";
import { fleetHome } from "../model/fleet-home.js";
import type { FleetSettings } from "../model/fleet-settings.js";
import { FleetConnectionSetup } from "../service/fleet-connection-setup.js";

/** A Fleet home, chart settings, and a fake client that lists `connections` and records commands. */
async function fixture(
  context: TestContext,
  connections: readonly ConnectionRecord[] = [],
) {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-connect-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const home = fleetHome(directory);
  const settings: FleetSettings = {
    home: directory,
    release: {
      version: "v3.0.0-beta",
      url: "https://releases.test",
      checksums: {},
    },
    namespace: "everything-fleet",
    storageClass: "",
    registry: {
      host: "registry.everything.test",
      insecure: false,
      username: "everything",
      password: "secret",
    },
  };
  const commands: string[][] = [];
  const fleet: FleetCommands = {
    /** List the given connections; accept every other command. */
    async run(args) {
      commands.push([...args]);
      if (args.join(" ") === "cluster ls --json")
        return JSON.stringify({
          clusters: connections.map((cluster) => ({ cluster })),
        });
      return "";
    },
  };
  return {
    home,
    commands,
    setup: new FleetConnectionSetup(fleet, home, settings),
  };
}

const managedFields = [
  "image.mode=registry",
  "image.registry=registry.everything.test",
  "image.insecure_registry=false",
  "storage_class=",
];

test("adds the in-cluster connection when fleetd has none", async (context) => {
  const { home, commands, setup } = await fixture(context, [
    { display_name: "laptop" },
  ]);
  await setup.apply();
  assert.deepEqual(commands.at(-1), [
    "cluster",
    "add",
    "everything",
    "--name=everything",
    "--namespace=everything-fleet",
    `--kubeconfig=${home.kubeconfig}`,
    ...managedFields,
    "allow_privileged=false",
  ]);
  const kubeconfig = JSON.parse(await readFile(home.kubeconfig, "utf8"));
  assert.equal(kubeconfig["current-context"], "everything");
  assert.equal(kubeconfig.contexts[0].context.namespace, "everything-fleet");
  assert.equal(
    kubeconfig.users[0].user.tokenFile,
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
  );
  assert.equal((await stat(home.kubeconfig)).mode & 0o777, 0o600);
});

test("updates the managed settings of an existing connection and keeps the user's privileged choice", async (context) => {
  const { commands, setup } = await fixture(context, [
    { display_name: "everything", allow_privileged: true },
  ]);
  await setup.apply();
  assert.deepEqual(commands, [
    ["cluster", "ls", "--json"],
    ["cluster", "set", "everything", ...managedFields],
  ]);
});

test("forbids privileged workers on a connection that leaves the choice to Fleet", async (context) => {
  const { commands, setup } = await fixture(context, [
    { display_name: "everything" },
  ]);
  await setup.apply();
  assert.deepEqual(commands.at(-1), [
    "cluster",
    "set",
    "everything",
    ...managedFields,
    "allow_privileged=false",
  ]);
});

test("adds the registry login while keeping the rest of Docker's configuration", async (context) => {
  const { home, setup } = await fixture(context);
  await mkdir(path.dirname(home.dockerConfig), { recursive: true });
  await writeFile(
    home.dockerConfig,
    JSON.stringify({
      auths: { "ghcr.io": { auth: "kept" } },
      currentContext: "default",
    }),
  );
  await setup.apply();
  const config = JSON.parse(await readFile(home.dockerConfig, "utf8"));
  assert.deepEqual(config, {
    auths: {
      "ghcr.io": { auth: "kept" },
      "registry.everything.test": {
        auth: Buffer.from("everything:secret").toString("base64"),
      },
    },
    currentContext: "default",
  });
  assert.equal((await stat(home.dockerConfig)).mode & 0o777, 0o600);
});
