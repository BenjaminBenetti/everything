import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../../agent/model/agent.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { PiSessionFactory } from "../adapter/pi-session-factory.js";

const agent: AgentDefinition = {
  id: "agent-id",
  ownerId: "owner",
  name: "Chosen",
  systemPrompt: "Help",
  avatarId: "avatar-01",
  createdAt: "",
};

/** A model runtime with no connected provider. */
const disconnectedModels = {
  /** No provider has credentials. */
  async getAvailable() {
    return [];
  },
} as unknown as ModelRuntime;

test("refuses to open a session until a provider is connected, before touching the agent's files", async (context) => {
  const agentsDirectory = await mkdtemp(
    path.join(tmpdir(), "everything-agents-"),
  );
  context.after(() => rm(agentsDirectory, { recursive: true, force: true }));
  const factory = new PiSessionFactory(
    disconnectedModels,
    new FileSystemWorkspaces(agentsDirectory),
  );
  await assert.rejects(
    factory.create(agent, async () => {}),
    { code: "PROVIDER_UNAVAILABLE" },
  );
  assert.equal(existsSync(path.join(agentsDirectory, agent.id)), false);
});
