import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { AgentSessionFactory } from "../../runtime/interface/agent-session.js";
import type { ConversationMessageStore } from "../interface/message-repository.js";
import type { ConversationMessage } from "../model/message.js";
import { ConversationService } from "../service/conversation-service.js";

/** Build controllable test doubles for testing concurrency independently of Pi and PostgreSQL. */
function fixture() {
  const recorded: Array<ConversationMessage & { agentId: string }> = [];
  const running = new Set<string>();
  const completions = new Map<string, () => void>();
  const deleted = new Set<string>();
  const lifecycle: string[] = [];
  let created = 0;
  let disposed = 0;
  let peakConcurrency = 0;
  let inference: AgentDefinition["inference"] = null;
  const agents: Pick<AgentCatalog, "get" | "delete"> = {
    /** Reject identities that do not own the definition. */
    async get(ownerId, id) {
      if (ownerId !== "owner" || deleted.has(id))
        throw new AgentNotFoundError();
      return {
        id,
        ownerId,
        name: "User chosen name",
        systemPrompt: "Reply deliberately",
        avatarId: "avatar-01",
        inference,
        createdAt: "",
      };
    },
    /** Record deletion for ownership and lifecycle checks. */
    async delete(_owner, id) {
      lifecycle.push(`definition-deleted:${id}`);
      deleted.add(id);
    },
  };
  const messages: ConversationMessageStore = {
    /** Record only explicitly submitted visible messages. */
    async append({ ownerId, agentId }, role, text) {
      assert.equal(ownerId, "owner");
      const message = {
        id: String(recorded.length + 1),
        agentId,
        role,
        text,
        createdAt: "",
      };
      recorded.push(message);
      return message;
    },
    /** Read the requested agent's messages. */
    async page({ ownerId, agentId }) {
      assert.equal(ownerId, "owner");
      return {
        messages: recorded.filter((message) => message.agentId === agentId),
        nextCursor: null,
      };
    },
  };
  const sessions: AgentSessionFactory = {
    /** Create a deferred runtime so tests control prompt completion. */
    async create(agent: AgentDefinition) {
      created++;
      return {
        id: "session-" + agent.id,
        compacting: false,
        lastToolName: undefined,
        typing: false,
        /** Remain active until aborted, or reject to simulate a provider failure. */
        async prompt(text) {
          if (text === "error") throw new Error("secret provider detail");
          assert.equal(
            running.has(agent.id),
            false,
            "An agent cannot have overlapping turns",
          );
          running.add(agent.id);
          peakConcurrency = Math.max(peakConcurrency, running.size);
          await new Promise<void>((resolve) => {
            completions.set(agent.id, resolve);
          });
          running.delete(agent.id);
        },
        /** Stop only this agent's active turn. */
        async abort() {
          completions.get(agent.id)?.();
        },
        /** Record lifecycle cleanup. */
        dispose() {
          lifecycle.push(`runtime-disposed:${agent.id}`);
          disposed++;
        },
      };
    },
  };
  return {
    service: new ConversationService(agents, messages, sessions, {
      /** Record removal of the agent's working directory. */
      async remove(agentId) {
        lifecycle.push(`files-removed:${agentId}`);
      },
    }),
    lifecycle,
    recorded,
    running,
    /** Simulate a durable profile edit between turns. */
    selectModel(selection: AgentDefinition["inference"]) {
      inference = selection;
    },
    /** Read counters after asynchronous work settles. */
    metrics() {
      return { created, disposed, peakConcurrency };
    },
  };
}

test("serializes rapid messages, interrupting earlier turns without overlapping them", async () => {
  const f = fixture();
  await Promise.all(
    ["first", "second", "third"].map((text) =>
      f.service.send("owner", "one", text),
    ),
  );
  assert.deepEqual(
    f.recorded.map((message) => message.text),
    ["first", "second", "third"],
  );
  assert.equal(f.metrics().created, 1);
  assert.equal(f.metrics().peakConcurrency, 1);
  assert.equal((await f.service.status("owner", "one")).status, "running");
  await f.service.interrupt("owner", "one");
  assert.equal((await f.service.status("owner", "one")).status, "idle");
  await f.service.close();
});

test("editing model settings reloads the runtime on the next turn without creating another conversation", async () => {
  const f = fixture();
  await f.service.send("owner", "one", "Before editing");
  f.selectModel({
    provider: "anthropic",
    model: "selected-model",
    effort: "high",
  });
  await f.service.send("owner", "one", "After editing");
  assert.equal(f.metrics().created, 2);
  assert.equal(f.metrics().disposed, 1);
  assert.equal(f.metrics().peakConcurrency, 1);
  assert.deepEqual(
    (await f.service.list("owner", "one")).messages.map(
      (message) => message.text,
    ),
    ["Before editing", "After editing"],
  );
  await f.service.close();
});

test("different agents can run concurrently and shutdown aborts both", async () => {
  const f = fixture();
  await Promise.all([
    f.service.send("owner", "one", "a"),
    f.service.send("owner", "two", "b"),
  ]);
  assert.equal(f.metrics().peakConcurrency, 2);
  await f.service.close();
  assert.equal(f.running.size, 0);
  assert.equal(f.metrics().disposed, 2);
  await assert.rejects(f.service.send("owner", "one", "late"), {
    code: "SHUTTING_DOWN",
  });
});

test("ownership is checked before reading messages or creating a runtime", async () => {
  const f = fixture();
  await assert.rejects(f.service.send("outsider", "one", "steal"), {
    code: "AGENT_NOT_FOUND",
  });
  await assert.rejects(f.service.list("outsider", "one"), {
    code: "AGENT_NOT_FOUND",
  });
  await assert.rejects(f.service.interrupt("outsider", "one"), {
    code: "AGENT_NOT_FOUND",
  });
  assert.equal(f.metrics().created, 0);
  assert.equal(f.recorded.length, 0);
});

test("provider failures surface safe status and retain the user's saved message", async () => {
  const f = fixture();
  await f.service.send("owner", "one", "error");
  await new Promise((resolve) => setImmediate(resolve));
  const status = await f.service.status("owner", "one");
  assert.equal(status.status, "error");
  assert.equal(status.error?.includes("secret"), false);
  assert.equal(f.recorded[0]?.text, "error");
  await f.service.close();
});

test("shutdown tolerates an agent deleted while shutdown waits for its lock", async () => {
  const f = fixture();
  await f.service.send("owner", "one", "work");
  await Promise.all([f.service.delete("owner", "one"), f.service.close()]);
  assert.equal(f.running.size, 0);
  assert.equal(f.metrics().disposed, 1);
});

test("deletion stops the runtime, removes desired state, then cleans up the workspace", async () => {
  const f = fixture();
  await f.service.send("owner", "one", "work");
  await f.service.delete("owner", "one");
  assert.equal(f.running.size, 0);
  assert.deepEqual(f.lifecycle, [
    "runtime-disposed:one",
    "definition-deleted:one",
    "files-removed:one",
  ]);
  await assert.rejects(f.service.send("owner", "one", "later"), {
    code: "AGENT_NOT_FOUND",
  });
});
