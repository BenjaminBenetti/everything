import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { AgentNamingService } from "../service/agent-naming-service.js";
import { agentNamingController } from "../controller/agent-naming-controller.js";
import { DataSource } from "typeorm";
import { PostgresAgentRepository } from "../repository/postgres-agent-repository.js";
import { AgentEntity } from "../schema/agent-entity.js";

test("renaming refuses omitted identifiers before reaching the ORM", async () => {
  const database = new DataSource({
    type: "postgres",
    entities: [AgentEntity],
  });
  const repository = new PostgresAgentRepository(database);
  await assert.rejects(
    repository.rename({ ownerId: "" }, "agent", "New"),
    /requires an owner/,
  );
  await assert.rejects(
    repository.rename({ ownerId: "owner" }, "", "New"),
    /requires an owner/,
  );
});

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

test("renaming is owner-scoped and preserves all other definition fields", async (context) => {
  const agent = {
    id: agentId,
    ownerId: "owner",
    name: "Before",
    systemPrompt: "Keep these instructions",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const calls: string[] = [];
  const service = new AgentNamingService({
    /** Model the owner predicate enforced by the database update. */
    async rename({ ownerId }, id, name) {
      calls.push(`${ownerId}:${id}`);
      return id === agentId && ownerId === "owner"
        ? { ...agent, name }
        : undefined;
    },
  });
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await agentNamingController(app, service);
  const response = await app.inject({
    method: "PATCH",
    url: `/agents/${agentId}`,
    payload: { name: "  After  " },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    id: agentId,
    name: "After",
    systemPrompt: agent.systemPrompt,
    createdAt: agent.createdAt,
  });
  assert.deepEqual(calls, [`owner:${agentId}`]);
  await assert.rejects(service.rename("outsider", agentId, "Stolen"), {
    code: "AGENT_NOT_FOUND",
  });
  await assert.rejects(service.rename("owner", "missing", "Lost"), {
    code: "AGENT_NOT_FOUND",
  });
});

test("renaming rejects blank, oversized, runtime, and ownership input before persistence", async (context) => {
  let calls = 0;
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await agentNamingController(app, {
    /** Fail if invalid HTTP input ever reaches the use case. */
    async rename() {
      calls++;
      throw new Error("Unexpected persistence");
    },
  });
  for (const body of [
    {},
    { name: " \n " },
    { name: "x".repeat(81) },
    { name: "Valid", ownerId: "outsider" },
    { name: "Valid", systemPrompt: "Changed" },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/agents/${agentId}`,
          payload: body,
        })
      ).statusCode,
      400,
    );
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
