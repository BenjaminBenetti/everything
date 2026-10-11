import assert from "node:assert/strict";
import { test } from "node:test";
import { DataSource, type FindOptionsWhere } from "typeorm";
import { agentAvatarIds } from "@everything/agent-contracts/avatar";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { AgentEditingService } from "../service/agent-editing-service.js";
import { agentEditingController } from "../controller/agent-editing-controller.js";
import type { AgentDefinition, UpdateAgentInput } from "../model/agent.js";
import { PostgresAgentRepository } from "../repository/postgres-agent-repository.js";
import { AgentEntity } from "../schema/agent-entity.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const foreignId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f12";
const missingId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f13";

/** A persisted definition that makes accidental changes to omitted fields visible. */
function definition(): AgentDefinition {
  return {
    id: agentId,
    ownerId: "owner",
    name: "Before",
    systemPrompt: "Keep these instructions",
    avatarId: "avatar-24",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

test("editing refuses omitted identifiers before reaching the ORM", async () => {
  const database = new DataSource({
    type: "postgres",
    entities: [AgentEntity],
  });
  const repository = new PostgresAgentRepository(database);
  await assert.rejects(
    repository.update({ ownerId: "" }, agentId, { name: "New" }),
    /requires an owner/,
  );
  await assert.rejects(
    repository.update({ ownerId: "owner" }, "", { name: "New" }),
    /requires an owner/,
  );
});

test("database updates and reloads apply ownership and update only supplied fields", async (context) => {
  const database = new DataSource({
    type: "postgres",
    entities: [AgentEntity],
  });
  const orm = database.getRepository(AgentEntity);
  const calls: unknown[] = [];
  context.mock.method(
    orm,
    "update",
    async (
      where: FindOptionsWhere<AgentDefinition>,
      changes: UpdateAgentInput,
    ) => {
      calls.push({ where, changes });
      return { affected: where.ownerId === "owner" ? 1 : 0 };
    },
  );
  context.mock.method(
    orm,
    "findOneBy",
    async (where: FindOptionsWhere<AgentDefinition>) => {
      calls.push({ read: where });
      return { ...definition(), avatarId: "avatar-64" };
    },
  );
  const repository = new PostgresAgentRepository(database);
  assert.equal(
    (
      await repository.update({ ownerId: "owner" }, agentId, {
        avatarId: "avatar-64",
      })
    )?.avatarId,
    "avatar-64",
  );
  assert.equal(
    await repository.update({ ownerId: "outsider" }, agentId, {
      name: "Stolen",
    }),
    undefined,
  );
  assert.deepEqual(calls, [
    {
      where: { ownerId: "owner", id: agentId },
      changes: { avatarId: "avatar-64" },
    },
    { read: { ownerId: "owner", id: agentId } },
    {
      where: { ownerId: "outsider", id: agentId },
      changes: { name: "Stolen" },
    },
  ]);
});

test("profile edits preserve omitted fields and return all public fields without ownership", async (context) => {
  let saved = definition();
  const service = new AgentEditingService({
    /** Apply the same owner predicate and partial updates as persistence. */
    async update({ ownerId }, id, changes) {
      if (id !== saved.id || ownerId !== saved.ownerId) return undefined;
      saved = { ...saved, ...changes };
      return saved;
    },
  });
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await agentEditingController(app, service);
  const changes: UpdateAgentInput[] = [
    { name: "  After  " },
    { systemPrompt: "  New instructions  " },
    { avatarId: "avatar-64" },
    {
      name: "  Final  ",
      systemPrompt: "  Final instructions  ",
      avatarId: "avatar-01",
    },
  ];
  let expected = definition();
  for (const change of changes) {
    const response = await app.inject({
      method: "PATCH",
      url: `/agents/${agentId}`,
      payload: change,
    });
    expected = {
      ...expected,
      name: change.name?.trim() ?? expected.name,
      systemPrompt: change.systemPrompt?.trim() ?? expected.systemPrompt,
      avatarId: change.avatarId ?? expected.avatarId,
    };
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      id: agentId,
      name: expected.name,
      systemPrompt: expected.systemPrompt,
      avatarId: expected.avatarId,
      createdAt: expected.createdAt,
    });
  }
});

test("foreign and missing profile edits are indistinguishable and leave definitions unchanged", async (context) => {
  const foreign = { ...definition(), id: foreignId, ownerId: "another-owner" };
  const before = { ...foreign };
  const service = new AgentEditingService({
    /** Refuse records outside the authenticated owner's scope. */
    async update({ ownerId }, id, changes) {
      return id === foreign.id && ownerId === foreign.ownerId
        ? { ...foreign, ...changes }
        : undefined;
    },
  });
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await agentEditingController(app, service);
  const responses = await Promise.all(
    [foreignId, missingId].map((id) =>
      app.inject({
        method: "PATCH",
        url: `/agents/${id}`,
        payload: {
          name: "Stolen",
          systemPrompt: "Overwritten",
          avatarId: "avatar-64",
        },
      }),
    ),
  );
  for (const response of responses) assert.equal(response.statusCode, 404);
  assert.deepEqual(responses[0]!.json(), responses[1]!.json());
  assert.equal(responses[0]!.json().code, "AGENT_NOT_FOUND");
  assert.deepEqual(foreign, before);
});

test("editing accepts all built-in avatars", async (context) => {
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await agentEditingController(app, {
    /** Echo the validated selection so schema widening cannot hide invalid IDs. */
    async update(_ownerId, _id, input) {
      return { ...definition(), ...input };
    },
  });
  assert.equal(new Set(agentAvatarIds).size, 64);
  for (const avatarId of agentAvatarIds) {
    const response = await app.inject({
      method: "PATCH",
      url: `/agents/${agentId}`,
      payload: { avatarId },
    });
    assert.equal(response.statusCode, 200, avatarId);
    assert.equal(response.json().avatarId, avatarId);
  }
});

test("editing rejects empty, invalid, runtime, and ownership input before persistence", async (context) => {
  let calls = 0;
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await agentEditingController(app, {
    /** Fail if invalid HTTP input ever reaches the use case. */
    async update() {
      calls++;
      throw new Error("Unexpected persistence");
    },
  });
  for (const payload of [
    {},
    { name: " \n " },
    { name: "x".repeat(81) },
    { name: null },
    { systemPrompt: " \n " },
    { systemPrompt: "x".repeat(16001) },
    { systemPrompt: null },
    { avatarId: "avatar-00" },
    { avatarId: "avatar-65" },
    { avatarId: "avatar-1" },
    { avatarId: "https://example.com/avatar.png" },
    { avatarId: null },
    { name: "Valid", ownerId: "outsider" },
    { name: "Valid", id: missingId },
    { name: "Valid", status: "running" },
    { name: "Valid", createdAt: "2026-01-01T00:00:00.000Z" },
  ]) {
    const response = await app.inject({
      method: "PATCH",
      url: `/agents/${agentId}`,
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().code, "INVALID_REQUEST");
  }
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/agents/bad-id",
        payload: { name: "Valid" },
      })
    ).statusCode,
    400,
  );
  assert.equal(calls, 0);
});
