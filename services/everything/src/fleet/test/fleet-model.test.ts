import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionFields } from "../model/fleet-connection.js";
import { fleetEnvironment, fleetHome } from "../model/fleet-home.js";
import {
  fleetArchitecture,
  fleetReleaseFiles,
} from "../model/fleet-release-files.js";
import type { FleetSettings } from "../model/fleet-settings.js";

test("maps Node.js architectures to Fleet's release names", () => {
  assert.equal(fleetArchitecture("x64"), "amd64");
  assert.equal(fleetArchitecture("arm64"), "arm64");
  assert.throws(() => fleetArchitecture("riscv64"));
  assert.deepEqual(
    fleetReleaseFiles("arm64").map((file) => file.asset),
    [
      "fleet-linux-arm64",
      "fleet-pod-linux-amd64",
      "fleet-tmux-linux-amd64.tar.gz",
      "fleet-pod-linux-arm64",
      "fleet-tmux-linux-arm64.tar.gz",
    ],
  );
});

test("gives Fleet its own home and keeps Everything's secrets out of its environment", () => {
  const home = fleetHome("/fleet");
  assert.equal(home.executable, "/fleet/.fleet/bin/fleet");
  assert.equal(home.socket, "/fleet/.fleet/fleet.sock");
  assert.deepEqual(
    fleetEnvironment(home, {
      HOME: "/state/home",
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///run/docker-socket/docker.sock",
      SSH_AUTH_SOCK: "/workspace/.ssh-agent/agent.sock",
      DATABASE_PASSWORD: "secret",
      REGISTRY_PASSWORD: "secret",
    }),
    {
      HOME: "/fleet",
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///run/docker-socket/docker.sock",
      SSH_AUTH_SOCK: "/workspace/.ssh-agent/agent.sock",
    },
  );
});

test("names the chart's storage class, or resets it for Fleet to choose", () => {
  const settings = {
    storageClass: "fast",
    registry: { host: "registry.example.com:443" },
  } as FleetSettings;
  assert.ok(connectionFields(settings).includes("storage_class=fast"));
  assert.ok(
    connectionFields(settings).includes(
      "image.registry=registry.example.com:443",
    ),
  );
  assert.ok(
    connectionFields({ ...settings, storageClass: "" }).includes(
      "storage_class=",
    ),
  );
});

test("verifies the registry's certificate unless the chart marks it a development registry", () => {
  const registry = {
    host: "registry.everything.test",
    insecure: false,
    username: "everything",
    password: "secret",
  };
  const settings = { storageClass: "", registry } as FleetSettings;
  assert.ok(
    connectionFields(settings).includes("image.insecure_registry=false"),
  );
  assert.ok(
    connectionFields({
      ...settings,
      registry: { ...registry, insecure: true },
    }).includes("image.insecure_registry=true"),
  );
});
