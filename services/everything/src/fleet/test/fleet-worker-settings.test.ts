import assert from "node:assert/strict";
import { test } from "node:test";
import type { FleetCommands } from "../interface/fleet-commands.js";
import type { ConnectionRecord } from "../model/fleet-connection.js";
import { FleetWorkerSettings } from "../service/fleet-worker-settings.js";

/** Worker settings over a fake Fleet client that keeps one connection and records commands. */
function fixture(
  connection: ConnectionRecord | undefined,
  options: { running?: boolean; failing?: boolean } = {},
) {
  const commands: string[][] = [];
  let current = connection;
  const fleet: FleetCommands = {
    /** List the connection, or apply `cluster set` to it. */
    async run(args) {
      commands.push([...args]);
      if (options.failing)
        throw new Error("fleet cluster ls failed: no daemon");
      if (args[1] === "set" && current)
        current = {
          ...current,
          allow_privileged: args[3] === "allow_privileged=true",
        };
      return JSON.stringify({
        clusters: current ? [{ cluster: current }] : [],
      });
    },
  };
  const settings = new FleetWorkerSettings(
    { running: options.running ?? true },
    fleet,
  );
  return { commands, settings };
}

test("reads whether Everything's connection allows privileged workers", async () => {
  assert.deepEqual(
    await fixture({
      display_name: "everything",
      allow_privileged: true,
    }).settings.read(),
    { privileged: true },
  );
  assert.deepEqual(
    await fixture({ display_name: "everything" }).settings.read(),
    { privileged: false },
  );
});

test("changes the connection and returns the settings as Fleet now reports them", async () => {
  const { commands, settings } = fixture({
    display_name: "everything",
    allow_privileged: false,
  });
  assert.deepEqual(await settings.update({ privileged: true }), {
    privileged: true,
  });
  assert.deepEqual(commands, [
    ["cluster", "set", "everything", "allow_privileged=true"],
    ["cluster", "ls", "--json"],
  ]);
});

test("reports workers unavailable before Fleet runs, without starting a daemon", async () => {
  const { commands, settings } = fixture(
    { display_name: "everything" },
    { running: false },
  );
  await assert.rejects(settings.read(), { code: "WORKERS_UNAVAILABLE" });
  await assert.rejects(settings.update({ privileged: true }), {
    code: "WORKERS_UNAVAILABLE",
  });
  assert.deepEqual(commands, []);
});

test("reports workers unavailable when fleetd fails or lacks Everything's connection", async () => {
  await assert.rejects(
    fixture({ display_name: "everything" }, { failing: true }).settings.read(),
    { code: "WORKERS_UNAVAILABLE", status: 503 },
  );
  await assert.rejects(fixture(undefined).settings.read(), {
    code: "WORKERS_UNAVAILABLE",
  });
});
