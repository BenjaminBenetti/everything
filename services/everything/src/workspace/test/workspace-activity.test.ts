import assert from "node:assert/strict";
import { test } from "node:test";
import { DataSource, type FindManyOptions } from "typeorm";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import type {
  WorkspaceActivityScope,
  WorkspaceStates,
} from "../interface/workspace-activity.js";
import { WorkspaceInstancesUnavailableError } from "../error/workspace-instance-errors.js";
import type { WorkspaceInteractionRecord } from "../model/workspace-interaction.js";
import { WorkspaceInteractionEntity } from "../schema/workspace-interaction-entity.js";
import { PostgresWorkspaceInteractionRepository } from "../repository/postgres-workspace-interaction-repository.js";
import {
  WorkspaceActivity,
  recentWorkspaceListing,
} from "../service/workspace-activity.js";
import { workspaceActivityController } from "../controller/workspace-activity-controller.js";
import { authenticatedTestServer } from "../../http/test/test-server.js";

test("recent workspaces are bounded, ordered, scoped, and omit deleted instances on refresh", async (context) => {
  const database = new DataSource({
    type: "postgres",
    entities: [WorkspaceInteractionEntity, AgentEntity],
  });
  const orm = database.getRepository(WorkspaceInteractionEntity);
  const rows: WorkspaceInteractionRecord[] = Array.from(
    { length: 12 },
    (_, index) => ({
      id: `interaction-${index}`,
      agentId: "avery",
      type: "web",
      name: `preview-${index}`,
      createdAt: "2026-10-14T00:00:00.000Z",
      lastInteractedAt: `2026-10-14T00:00:${String(index).padStart(2, "0")}.000Z`,
    }),
  );
  context.mock.method(
    orm,
    "find",
    async (options: FindManyOptions<WorkspaceInteractionRecord>) => {
      assert.deepEqual(options, {
        where: { agentId: "avery", agent: { ownerId: "owner" } },
        order: { lastInteractedAt: "DESC", id: "DESC" },
        take: 10,
      });
      return rows.toReversed().slice(0, options.take);
    },
  );
  const repository = new PostgresWorkspaceInteractionRepository(
    database,
    recentWorkspaceListing,
  );
  let states: Awaited<ReturnType<WorkspaceStates["states"]>> = rows.map(
    ({ type, name }, index) => ({
      type,
      name,
      status:
        index === 11
          ? "creating"
          : index === 10
            ? "running"
            : index === 9
              ? "stopped"
              : "unknown",
    }),
  );
  let unavailable = false;
  const activity = new WorkspaceActivity(
    {
      get: async (owner, id) => {
        assert.equal(owner, "owner");
        assert.equal(id, "avery");
        return {
          id,
          ownerId: owner,
          name: "Avery",
          createdAt: "",
          avatarId: "avatar-01",
          systemPrompt: "Help.",
          inference: null,
        };
      },
    },
    repository,
    {
      /** Report current identities separately from temporary lifecycle lookup failures. */
      async states() {
        if (unavailable) throw new WorkspaceInstancesUnavailableError();
        return states;
      },
    },
    () => Date.parse("2026-10-14T00:00:12.000Z"),
  );
  const result = await activity.recent({ ownerId: "owner", agentId: "avery" });
  assert.equal(result.workspaces.length, 10);
  assert.deepEqual(
    result.workspaces.map((item) => item.name),
    rows
      .toReversed()
      .slice(0, 10)
      .map((item) => item.name),
  );
  assert.deepEqual(
    result.workspaces.slice(0, 4).map((item) => item.status),
    ["creating", "running", "stopped", "unknown"],
  );
  assert.equal(result.observedAt, "2026-10-14T00:00:12.000Z");
  assert.equal("agentId" in result.workspaces[0]!, false);

  // A same-named instance of another type cannot keep a deleted workspace in the card.
  states = states.map((item) =>
    item.name === "preview-10" ? { ...item, type: "other-type" } : item,
  );
  const refreshed = await activity.recent({
    ownerId: "owner",
    agentId: "avery",
  });
  assert.deepEqual(
    refreshed.workspaces,
    result.workspaces.filter((item) => item.name !== "preview-10"),
  );

  unavailable = true;
  await assert.rejects(
    activity.recent({ ownerId: "owner", agentId: "avery" }),
    WorkspaceInstancesUnavailableError,
  );
  unavailable = false;
  assert.deepEqual(
    (await activity.recent({ ownerId: "owner", agentId: "avery" })).workspaces,
    refreshed.workspaces,
  );

  states = [];
  assert.deepEqual(
    (await activity.recent({ ownerId: "owner", agentId: "avery" })).workspaces,
    [],
  );
});

test("another chat or owner cannot contribute timestamps, and reads never renew activity", async () => {
  let now = Date.parse("2026-10-14T00:00:00.000Z");
  const rows = new Map<string, WorkspaceInteractionRecord>();
  const activity = new WorkspaceActivity(
    {
      get: async (ownerId, id) => {
        if (ownerId !== "owner" || !["avery", "blake"].includes(id))
          throw new AgentNotFoundError();
        return {
          id,
          ownerId,
          name: id,
          createdAt: "",
          avatarId: "avatar-01",
          systemPrompt: "Help.",
          inference: null,
        };
      },
    },
    {
      /** Keep the fixture's persisted rows partitioned exactly as the repository contract requires. */
      async list(scope) {
        return [...rows.values()].filter(
          (row) => row.agentId === scope.agentId,
        );
      },
      /** A repeated workspace replaces its previous timestamp for that teammate only. */
      async touch(scope, workspace, at) {
        const id = JSON.stringify([
          scope.ownerId,
          scope.agentId,
          workspace.type,
          workspace.name,
        ]);
        rows.set(id, {
          ...workspace,
          id,
          agentId: scope.agentId,
          lastInteractedAt: at,
          createdAt: at,
        });
      },
    },
    {
      states: async () => [{ type: "web", name: "shared", status: "running" }],
    },
    () => now,
  );
  const avery = { ownerId: "owner", agentId: "avery" };
  await activity.touch(avery, { type: "web", name: "shared" });
  const initial = (await activity.recent(avery)).workspaces[0]!
    .lastInteractedAt;
  now += 6_000;
  await activity.touch(
    { ...avery, agentId: "blake" },
    { type: "web", name: "shared" },
  );
  assert.equal(
    (await activity.recent(avery)).workspaces[0]!.lastInteractedAt,
    initial,
  );
  assert.notEqual(
    (await activity.recent({ ...avery, agentId: "blake" })).workspaces[0]!
      .lastInteractedAt,
    initial,
  );
  await assert.rejects(
    activity.recent({ ownerId: "outsider", agentId: "avery" }),
    AgentNotFoundError,
  );
  await assert.rejects(
    activity.recent({ ...avery, agentId: "missing" }),
    AgentNotFoundError,
  );
  now += 1_000;
  await activity.touch(avery, { type: "web", name: "shared" });
  assert.equal((await activity.recent(avery)).workspaces.length, 1);
  assert.equal(rows.size, 2);
});

test("activity transport validates teammate IDs and derives ownership from authentication", async (context) => {
  const app = authenticatedTestServer();
  context.after(() => app.close());
  const calls: WorkspaceActivityScope[] = [];
  const id = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
  await workspaceActivityController(app, {
    /** Capture the server's scope; arbitrary request headers must not select the owner. */
    async recent(scope) {
      calls.push(scope);
      return { observedAt: new Date().toISOString(), workspaces: [] };
    },
  });
  const result = await app.inject({
    url: `/agents/${id}/workspaces`,
    headers: { "x-owner-id": "outsider" },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().workspaces, []);
  assert.deepEqual(calls, [{ ownerId: "owner", agentId: id }]);
  assert.equal(
    (await app.inject({ url: "/agents/invalid/workspaces" })).statusCode,
    400,
  );
  assert.equal(calls.length, 1);
});
