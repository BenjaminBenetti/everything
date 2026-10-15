import assert from "node:assert/strict";
import { test } from "node:test";
import { FleetWorkspaces } from "../service/fleet-workspaces.js";
import {
  WorkspaceInstanceConflictError,
  WorkspaceInstanceNotFoundError,
  WorkspaceInstancesUnavailableError,
} from "../../workspace/error/workspace-instance-errors.js";
import type { FleetInstance } from "../schema/fleet-instance.js";

/** A mutable runtime with two types containing the same instance name. */
function fixture() {
  const instances: FleetInstance[] = [
    {
      fleet: "web",
      instance: "dev-1",
      status: "running",
      container_id: "container-a",
    },
    { fleet: "api", instance: "dev-1", status: "stopped" },
    { fleet: "web", instance: "dev-2", status: "future-state" },
  ];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const workspaces = new FleetWorkspaces(
    {
      /** Emulate the runtime's state changes and its asynchronous deletion receipt. */
      async call(name, args) {
        calls.push({ name, args });
        if (name === "fleet_list")
          return { instances: structuredClone(instances) };
        const instance = instances.find(
          (item) =>
            item.fleet === args.fleet && item.instance === args.instance,
        )!;
        instance.status =
          name === "fleet_start"
            ? "running"
            : name === "fleet_stop"
              ? "stopped"
              : "deleting";
        return name === "fleet_down"
          ? { done: false, job_id: "delete-job" }
          : { done: true, success: true };
      },
    },
    {
      /** Only the running instance has a resource sample. */
      async read(ids) {
        assert.deepEqual(ids, ["container-a"]);
        return new Map([
          ["container-a", { cpuCores: 0.25, memoryBytes: 536870912 }],
        ]);
      },
    },
  );
  return { workspaces, instances, calls };
}

test("lists types, translates metrics, and leaves unknown usage and states explicit", async () => {
  const { workspaces } = fixture();
  assert.deepEqual(await workspaces.list(), [
    {
      type: "web",
      name: "dev-1",
      status: "running",
      resources: { cpuCores: 0.25, memoryBytes: 536870912 },
    },
    {
      type: "api",
      name: "dev-1",
      status: "stopped",
      resources: { cpuCores: 0, memoryBytes: 0 },
    },
    {
      type: "web",
      name: "dev-2",
      status: "unknown",
      resources: { cpuCores: null, memoryBytes: null },
    },
  ]);
});

test("controls exactly the requested instance and accepts asynchronous deletion", async () => {
  const { workspaces, calls, instances } = fixture();
  const target = { type: "api", name: "dev-1" };
  await workspaces.start(target);
  assert.equal(instances[0]!.status, "running");
  await workspaces.stop(target);
  await workspaces.delete(target);
  assert.deepEqual(
    calls.filter((call) => call.name !== "fleet_list"),
    [
      { name: "fleet_start", args: { fleet: "api", instance: "dev-1" } },
      { name: "fleet_stop", args: { fleet: "api", instance: "dev-1" } },
      { name: "fleet_down", args: { fleet: "api", instance: "dev-1" } },
    ],
  );
  assert.equal(instances[1]!.status, "deleting");
});

test("rejects deletion in every state except stopped without issuing a destructive tool", async () => {
  const { workspaces, instances, calls } = fixture();
  for (const status of [
    "running",
    "creating",
    "cloning",
    "starting",
    "stopping",
    "failed",
    "deleting",
    "rebuilding",
    "unknown",
  ]) {
    instances[0]!.status = status;
    await assert.rejects(
      workspaces.delete({ type: "web", name: "dev-1" }),
      WorkspaceInstanceConflictError,
    );
  }
  await assert.rejects(
    workspaces.delete({ type: "missing", name: "dev-1" }),
    WorkspaceInstanceNotFoundError,
  );
  assert.equal(
    calls.some((call) => call.name === "fleet_down"),
    false,
  );
});

test("serializes conflicting actions and rechecks the state after an earlier start", async () => {
  const { workspaces, calls } = fixture();
  const target = { type: "api", name: "dev-1" };
  const outcomes = await Promise.allSettled([
    workspaces.start(target),
    workspaces.delete(target),
  ]);
  assert.equal(outcomes[0]!.status, "fulfilled");
  assert.equal(outcomes[1]!.status, "rejected");
  assert.equal(
    calls.some((call) => call.name === "fleet_down"),
    false,
  );
});

test("treats already-settled start and stop requests as idempotent", async () => {
  const { workspaces, calls } = fixture();
  await workspaces.start({ type: "web", name: "dev-1" });
  await workspaces.stop({ type: "api", name: "dev-1" });
  assert.equal(
    calls.every((call) => call.name === "fleet_list"),
    true,
  );
});

test("rejects malformed runtime data and hides internal tool failures", async () => {
  for (const result of [
    {},
    { instances: null },
    { instances: [{ fleet: "web", instance: "dev-1" }] },
    new Error("private runtime path"),
  ]) {
    const workspaces = new FleetWorkspaces(
      {
        /** Simulate an unavailable or incompatible runtime. */
        async call() {
          if (result instanceof Error) throw result;
          return result;
        },
      },
      {
        /** No metrics are needed for a rejected listing. */ async read() {
          return new Map();
        },
      },
    );
    await assert.rejects(workspaces.list(), WorkspaceInstancesUnavailableError);
  }
});
