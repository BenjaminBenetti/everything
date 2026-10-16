import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { PiForkHistory } from "../adapter/pi-fork-history.js";
import { PiSubagentArchives } from "../../subagent/adapter/pi-subagent-archives.js";

/** Construct a native assistant event without involving a model provider. */
function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "test",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("native subagent history excludes inherited context, thinking, provider failures, and arbitrary tools", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "subagent-history-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = SessionManager.create(
    directory,
    path.join(directory, ".pi", "sessions"),
  );
  root.appendMessage({
    role: "user",
    content: "PRIVATE_MAIN_HISTORY",
    timestamp: Date.now(),
  });
  const histories = new PiForkHistory(
    directory,
    path.join(directory, ".pi"),
    root,
  );
  const child = histories.fork("main", true);
  const id = child.getSessionId();
  child.appendMessage({
    role: "user",
    content: "Own task",
    timestamp: Date.now(),
  });
  child.appendMessage(
    assistant(
      [
        { type: "thinking", thinking: "PRIVATE_THINKING" },
        {
          type: "toolCall",
          id: "shell",
          name: "bash",
          arguments: { command: "PRIVATE_COMMAND" },
        },
        {
          type: "toolCall",
          id: "delivered",
          name: "send_message",
          arguments: { text: "Progress for parent" },
        },
        {
          type: "toolCall",
          id: "failed",
          name: "send_message",
          arguments: { text: "FAILED_DELIVERY" },
        },
      ],
      "toolUse",
    ),
  );
  for (const toolCallId of ["shell", "delivered", "failed"])
    child.appendMessage({
      role: "toolResult",
      toolCallId,
      toolName: toolCallId,
      content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }],
      isError: toolCallId === "failed",
      timestamp: Date.now(),
    });
  child.appendMessage(
    assistant([{ type: "text", text: "PRIVATE_PROVIDER_ERROR" }], "error"),
  );
  child.appendMessage(assistant([{ type: "text", text: "Finished result" }]));
  const page = histories.messages(id);
  assert.deepEqual(
    page.messages.map((message) => [message.role, message.text]),
    [
      ["user", "Own task"],
      ["assistant", "Progress for parent"],
      ["assistant", "Finished result"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_|FAILED_DELIVERY/);
  assert.throws(() => histories.messages("main"), {
    code: "SUBAGENT_NOT_FOUND",
  });
  for (let index = 0; index < 105; index++)
    child.appendMessage({
      role: "user",
      content: `Message ${index}`,
      timestamp: Date.now(),
    });
  const recent = histories.messages(id);
  assert.equal(recent.messages.length, 100);
  assert.equal(recent.messages.at(-1)!.text, "Message 104");
  const older = histories.messages(id, recent.nextCursor!);
  assert.equal(older.messages.length, 8);
  assert.equal(older.nextCursor, null);
  assert.deepEqual(histories.messages(id, "foreign-cursor"), {
    messages: [],
    nextCursor: null,
  });
  const reopened = new PiForkHistory(
    directory,
    path.join(directory, ".pi"),
    SessionManager.continueRecent(
      directory,
      path.join(directory, ".pi", "sessions"),
    ),
  );
  await reopened.restore();
  assert.deepEqual(reopened.messages(id), recent);
});

test("a never-prompted main and its empty background sessions persist, and cold deletion removes only the selected subtree", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "subagent-empty-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = path.join(directory, ".pi");
  const root = SessionManager.create(
    directory,
    path.join(agentDir, "sessions"),
  );
  const histories = new PiForkHistory(directory, agentDir, root);
  const parent = histories.fork("main");
  const child = histories.fork(parent.getSessionId());
  const sibling = histories.fork("main");
  const archive = new PiSubagentArchives({ directory: () => directory });
  const scope = { ownerId: "owner", agentId: "teammate" };
  const saved = await archive.open(scope);
  assert.equal(saved.list().length, 3);
  assert.ok(saved.list().every((fork) => fork.status === "stopped"));
  assert.deepEqual(saved.messages(parent.getSessionId()), {
    messages: [],
    nextCursor: null,
  });
  await saved.delete(parent.getSessionId());
  const reopened = await archive.open(scope);
  assert.deepEqual(
    reopened.list().map((fork) => fork.id),
    [sibling.getSessionId()],
  );
  for (const id of [parent.getSessionId(), child.getSessionId()])
    assert.throws(() => reopened.messages(id), { code: "SUBAGENT_NOT_FOUND" });
  assert.equal(
    (await readdir(path.join(agentDir, "forks", root.getSessionId()))).length,
    1,
  );
  assert.equal(
    SessionManager.continueRecent(
      directory,
      path.join(agentDir, "sessions"),
    ).getSessionId(),
    root.getSessionId(),
  );
});

test("reopening prunes interrupted temporary trees, including descendants whose parent was already removed", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "subagent-event-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = path.join(directory, ".pi");
  const root = SessionManager.create(
    directory,
    path.join(agentDir, "sessions"),
  );
  const histories = new PiForkHistory(directory, agentDir, root);
  const retained = histories.fork("main");
  const event = histories.fork("main", true, true);
  const child = histories.fork(event.getSessionId(), true);
  histories.fork(child.getSessionId());
  const orphanedEvent = histories.fork("main", false, true);
  histories.fork(orphanedEvent.getSessionId());
  await histories.remove([orphanedEvent.getSessionId()]);
  const archive = await new PiSubagentArchives({
    directory: () => directory,
  }).open({ ownerId: "owner", agentId: "teammate" });
  assert.deepEqual(
    archive.list().map((item) => item.id),
    [retained.getSessionId()],
  );
  for (const id of [event.getSessionId(), child.getSessionId()])
    assert.throws(() => archive.messages(id), { code: "SUBAGENT_NOT_FOUND" });
  assert.equal(
    (await readdir(path.join(agentDir, "forks", root.getSessionId()))).length,
    1,
  );
  assert.equal(
    SessionManager.continueRecent(
      directory,
      path.join(agentDir, "sessions"),
    ).getSessionId(),
    root.getSessionId(),
  );
});
