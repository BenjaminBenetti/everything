import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnerScope } from "@everything/persistence/repository";
import type { AgentRepository } from "../interface/agent-repository.js";
import type { AgentDefinition, CreateAgentInput } from "../model/agent.js";
import { AgentService } from "../service/agent-service.js";

/** In-memory repository that applies owner scope like the PostgreSQL implementation. */
function fixture() {
  const stored: AgentDefinition[] = [];
  const deleted: string[] = [];
  const repository: AgentRepository = {
    /** List definitions owned by the scope. */
    async list({ ownerId }) {
      return stored.filter((agent) => agent.ownerId === ownerId);
    },
    /** Store the new agent for its owner. */
    async create({ ownerId }: OwnerScope, agent: CreateAgentInput) {
      const saved = {
        ...agent,
        id: String(stored.length + 1),
        ownerId,
        createdAt: "",
      };
      stored.push(saved);
      return saved;
    },
    /** Hide definitions owned by another subject. */
    async getById({ ownerId }, id) {
      return stored.find(
        (agent) => agent.id === id && agent.ownerId === ownerId,
      );
    },
    /** Record the deletion request. */
    async delete(_scope, id) {
      deleted.push(id);
    },
  };
  return { service: new AgentService(repository), deleted };
}

test("new agents belong to their creator and are listed only for them", async () => {
  const { service } = fixture();
  const agent = await service.create("owner", {
    name: "Chosen",
    systemPrompt: "Help",
  });
  assert.equal(agent.ownerId, "owner");
  assert.deepEqual(await service.list("owner"), [agent]);
  assert.deepEqual(await service.list("someone-else"), []);
});

test("foreign and missing agents are indistinguishable and never deleted", async () => {
  const { service, deleted } = fixture();
  const agent = await service.create("owner", {
    name: "Chosen",
    systemPrompt: "Help",
  });
  for (const [ownerId, id] of [
    ["someone-else", agent.id],
    ["owner", "missing"],
  ] as const) {
    await assert.rejects(service.get(ownerId, id), { code: "AGENT_NOT_FOUND" });
    await assert.rejects(service.delete(ownerId, id), {
      code: "AGENT_NOT_FOUND",
    });
  }
  assert.deepEqual(deleted, []);
  await service.delete("owner", agent.id);
  assert.deepEqual(deleted, [agent.id]);
});
