import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForkableSession } from "../interface/session-forks.js";
import { ForkingAgentSession } from "../service/forking-agent-session.js";
import { AgentRuntime } from "../service/agent-runtime.js";

/** Allow completion and routing microtasks to settle without relying on elapsed time. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Controllable session that detects concurrent prompts and completes only when instructed. */
function controlled(id: string) {
  const prompts: string[] = [];
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let output: string | undefined;
  let disposed = false;
  let aborts = 0;
  let lastToolName: string | undefined;
  const session: ForkableSession = {
    id,
    compacting: false,
    typing: false,
    /** Report the last tool of the current turn, as Pi does. */
    get lastToolName() {
      return lastToolName;
    },
    /** Read only the latest completed response. */
    get lastResponse() {
      return output;
    },
    /** Detect overlapping requests while holding this model turn open. */
    async prompt(text) {
      assert.equal(resolve, undefined, `${id} has overlapping prompts`);
      prompts.push(text);
      lastToolName = undefined;
      await new Promise<void>((done, failed) => {
        resolve = done;
        reject = failed;
      });
    },
    /** Release in-flight work on cancellation. */
    async abort() {
      aborts++;
      const done = resolve;
      resolve = undefined;
      done?.();
    },
    /** Record teardown. */
    async dispose() {
      disposed = true;
    },
  };
  return {
    session,
    prompts,
    /** Finish the active turn with text available for private parent delivery. */
    finish(text = "Finished") {
      output = text;
      const done = resolve;
      resolve = undefined;
      done?.();
    },
    /** Record a tool completed before this turn's final text. */
    used(tool: string) {
      lastToolName = tool;
    },
    /** Simulate an unexpected provider error that must remain private. */
    fail() {
      resolve = undefined;
      reject?.(new Error("secret provider response"));
    },
    /** Inspect lifecycle without exposing mutable test state. */
    state() {
      return { disposed, aborts, running: resolve !== undefined };
    },
  };
}

/** Wire a real coordinator to controllable sessions and an independently advanceable clock. */
function fixture() {
  let now = 0;
  const main = controlled("main-session");
  const children = new Map<string, ReturnType<typeof controlled>>();
  const removed: string[] = [];
  const family = new ForkingAgentSession(
    main.session,
    {
      /** Return an independently controlled copy for each requested parent. */
      async create() {
        const child = controlled(`fork-${children.size + 1}`);
        children.set(child.session.id, child);
        return child.session;
      },
    },
    () => now,
    {
      messages: () => ({ messages: [], nextCursor: null }),
      remove: async (ids) => {
        removed.push(...ids);
      },
    },
  );
  return {
    family,
    main,
    children,
    removed,
    tools: family.operations("main"),
    /** Advance indicator time without real waits or triggering runtime work. */
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

test("forks return immediately, work concurrently, and wake an idle main session with results", async () => {
  const f = fixture();
  const runtime = new AgentRuntime(f.family);
  assert.equal(runtime.status.backgroundCount, 0);
  const first = await f.tools.fork("Research");
  const second = await f.tools.fork("Build");
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  assert.equal(f.main.prompts.length, 0);
  assert.equal(f.family.background.running, true);
  assert.equal(runtime.status.backgroundCount, 2);
  f.children.get(first.id)!.finish("Research result");
  await settle();
  assert.match(f.main.prompts[0]!, /Fork fork-1 finished:\nResearch result/);
  assert.equal(f.children.get(second.id)!.state().running, true);
  f.advance(10_000);
  assert.equal(
    runtime.status.backgroundCount,
    1,
    "the awakened main session is not a background teammate",
  );
  f.main.finish();
  await f.family.abort();
  assert.equal(runtime.status.backgroundCount, 0);
  await f.family.dispose();
  assert.ok([...f.children.values()].every((child) => child.state().disposed));
});

test("API work queues messages without interrupting main, and can resume after the whole family stops", async () => {
  const f = fixture();
  const mainTurn = f.family.prompt("Keep main working");
  const child = await f.family.subagents!.create({ task: "API task" });
  const worker = f.children.get(child.id)!;
  assert.equal(f.main.state().running, true);
  assert.equal(f.main.state().aborts, 0);
  assert.match(worker.prompts[0]!, /Background task from API consumer/);
  f.family.subagents!.send(child.id, "Followup");
  assert.equal(worker.prompts.length, 1);
  worker.finish("Initial result");
  await settle();
  assert.match(
    worker.prompts[1]!,
    /Private message from API consumer:\nFollowup/,
  );
  assert.equal(
    f.main.prompts.length,
    1,
    "results queue behind the active main turn",
  );
  await f.family.abort();
  await mainTurn;
  f.family.subagents!.send(child.id, "Resume after stop");
  worker.finish("Resumed result");
  await settle();
  assert.match(f.main.prompts.at(-1)!, /Resumed result/);
  await f.family.abort();
  await f.family.subagents!.create({ task: "New API work after stop" });
  assert.equal(f.family.subagents!.list().length, 2);
  await f.family.abort();
});

test("API deletion stops and removes a whole subtree, suppresses late reports, and retains siblings", async () => {
  const f = fixture();
  const parent = await f.family.subagents!.create({ task: "Parent" });
  const child = await f.family.operations(parent.id).fork("Child");
  const sibling = await f.family.subagents!.create({ task: "Sibling" });
  const deleting = f.family.subagents!.delete(parent.id);
  assert.throws(
    () => f.family.operations(sibling.id).send(child.id, "Too late"),
    { code: "FORK_UNAVAILABLE" },
  );
  await deleting;
  await settle();
  assert.deepEqual(
    f.family.subagents!.list().map((item) => item.id),
    [sibling.id],
  );
  assert.deepEqual(f.removed, [parent.id, child.id]);
  assert.equal(f.main.prompts.length, 0);
  for (const id of [parent.id, child.id]) {
    assert.equal(f.children.get(id)!.state().disposed, true);
    assert.throws(() => f.family.subagents!.send(id, "Gone"), {
      code: "SUBAGENT_NOT_FOUND",
    });
    assert.throws(() => f.family.subagents!.messages(id), {
      code: "SUBAGENT_NOT_FOUND",
    });
  }
  assert.throws(
    () => f.family.subagents!.send("main", "Not a background address"),
    { code: "SUBAGENT_NOT_FOUND" },
  );
  await f.family.abort();
  await f.family.subagents!.delete(sibling.id);
  assert.equal(f.family.subagents!.list().length, 0);
});

test("a descendant still opening when its parent is deleted is discarded with its native history", async () => {
  const main = controlled("main-session");
  const parent = controlled("parent");
  const child = controlled("late-child");
  const removed: string[] = [];
  let release!: (session: ForkableSession) => void;
  const family = new ForkingAgentSession(
    main.session,
    {
      create: async (parentId) =>
        parentId === "main"
          ? parent.session
          : new Promise((resolve) => {
              release = resolve;
            }),
    },
    undefined,
    {
      messages: () => ({ messages: [], nextCursor: null }),
      remove: async (ids) => {
        removed.push(...ids);
      },
    },
  );
  await family.subagents!.create({ task: "Parent task" });
  const opening = family.operations(parent.session.id).fork("Late child");
  const rejected = assert.rejects(opening, { code: "FORK_UNAVAILABLE" });
  await family.subagents!.delete(parent.session.id);
  release(child.session);
  await rejected;
  assert.equal(child.state().disposed, true);
  assert.deepEqual(removed, [parent.session.id, child.session.id]);
  assert.equal(family.subagents!.list().length, 0);
  await family.abort();
});

test("the background count retains short pauses and expires ten seconds after the latest turn ends", async () => {
  const f = fixture();
  const runtime = new AgentRuntime(f.family);
  const child = await f.tools.fork("Work");
  assert.equal(runtime.status.backgroundCount, 1);
  const worker = f.children.get(child.id)!;
  worker.finish("First result");
  await settle();
  f.main.finish();
  await settle();
  assert.equal(
    runtime.status.status,
    "idle",
    "display grace does not keep execution running",
  );
  f.advance(5000);
  assert.equal(runtime.status.backgroundCount, 1);
  f.tools.send(child.id, "Continue");
  assert.equal(
    runtime.status.backgroundCount,
    1,
    "resuming within the grace period counts the fork once",
  );
  f.advance(20_000);
  assert.equal(
    runtime.status.backgroundCount,
    1,
    "a running turn never expires",
  );
  worker.finish("Second result");
  await settle();
  f.advance(9999);
  assert.equal(runtime.status.backgroundCount, 1);
  f.advance(1);
  assert.equal(runtime.status.backgroundCount, 0);
  f.tools.send(child.id, "Start again");
  assert.equal(
    runtime.status.backgroundCount,
    1,
    "new activity appears immediately",
  );
  await runtime.close();
});

test("each fork has its own idle grace period and explicit stop clears recent activity", async () => {
  const f = fixture();
  const first = await f.tools.fork("First");
  const second = await f.tools.fork("Second");
  f.children.get(first.id)!.finish();
  await settle();
  f.advance(6000);
  f.children.get(second.id)!.finish();
  await settle();
  assert.equal(f.family.background.activeCount, 2);
  f.advance(4000);
  assert.equal(f.family.background.activeCount, 1);
  await f.tools.stop(second.id);
  assert.equal(f.family.background.activeCount, 0);
  f.tools.send(first.id, "Resume");
  f.children.get(first.id)!.finish();
  await settle();
  assert.equal(f.family.background.activeCount, 1);
  await f.family.abort();
  assert.equal(f.family.background.activeCount, 0);
});

test("private messages queue in order while busy and explicit replies are not duplicated", async () => {
  const f = fixture();
  const child = await f.tools.fork("First task");
  f.tools.send(child.id, "Second task");
  f.tools.send(child.id, "Third task");
  const worker = f.children.get(child.id)!;
  assert.equal(worker.prompts.length, 1);
  f.family.operations(child.id).send("parent", "Progress");
  worker.used("send_message");
  assert.match(f.main.prompts[0]!, /Private message from fork-1:\nProgress/);
  worker.finish("Do not duplicate the explicit result");
  await settle();
  assert.match(worker.prompts[1]!, /Second task/);
  f.main.finish();
  await settle();
  assert.equal(f.main.prompts.length, 1);
  worker.finish("Second result");
  await settle();
  assert.match(f.main.prompts[1]!, /Second result/);
  assert.match(worker.prompts[2]!, /Third task/);
  await f.family.abort();
});

test("new user input preserves forks and queued private messages while Stop cancels every session", async () => {
  const f = fixture();
  const runtime = new AgentRuntime(f.family);
  runtime.start("User task");
  const child = await f.tools.fork("Background task");
  await runtime.stop("turn");
  assert.equal(f.children.get(child.id)!.state().aborts, 0);
  f.family
    .operations(child.id)
    .send("parent", "Result arriving between user turns");
  runtime.start("New user input");
  assert.equal(f.main.prompts.at(-1), "New user input");
  f.main.finish();
  await settle();
  assert.match(f.main.prompts.at(-1)!, /Result arriving between user turns/);
  f.main.finish();
  await settle();
  assert.equal(
    runtime.status.status,
    "running",
    "background work keeps Stop available",
  );
  await runtime.stop();
  assert.equal(runtime.status.status, "idle");
  assert.equal(f.children.get(child.id)!.state().running, false);
  assert.equal(
    f.main.prompts.length,
    3,
    "cancelled work does not wake the main session",
  );
  await runtime.close();
});

test("a fork can fork itself and exchange messages, while cancellation reaches descendants only", async () => {
  const f = fixture();
  const first = await f.tools.fork("Parent");
  const sibling = await f.tools.fork("Sibling");
  const nested = await f.family.operations(first.id).fork("Nested task");
  assert.equal(
    f.family.background.activeCount,
    3,
    "nested forks count once each",
  );
  f.family.operations(nested.id).send("parent", "Nested progress");
  assert.equal(
    f.tools.list().find((item) => item.id === nested.id)!.parentId,
    first.id,
  );
  await assert.rejects(f.family.operations(nested.id).stop(first.id), {
    code: "FORK_UNAVAILABLE",
  });
  await f.tools.stop(first.id);
  assert.equal(f.children.get(first.id)!.state().running, false);
  assert.equal(f.children.get(nested.id)!.state().running, false);
  assert.equal(f.children.get(sibling.id)!.state().running, true);
  assert.equal(f.family.background.activeCount, 1);
  assert.throws(() => f.family.operations(first.id).send("main", "late"), {
    code: "FORK_UNAVAILABLE",
  });
  f.tools.send(first.id, "Resume");
  assert.equal(f.children.get(first.id)!.state().running, true);
  assert.equal(f.family.background.activeCount, 2);
  await f.family.abort();
});

test("foreign addresses and excessive concurrent work are rejected without exposing other families", async () => {
  const f = fixture();
  assert.throws(() => f.tools.send("../other-teammate", "steal"), {
    code: "FORK_UNAVAILABLE",
  });
  assert.throws(() => f.tools.send("parent", "missing"), {
    code: "FORK_UNAVAILABLE",
  });
  await assert.rejects(f.family.operations("other").fork("steal"), {
    code: "FORK_UNAVAILABLE",
  });
  for (let i = 0; i < 8; i++) await f.tools.fork(`Task ${i}`);
  await assert.rejects(f.tools.fork("One too many"), { code: "FORK_LIMIT" });
  await assert.rejects(
    f.family.subagents!.wakeup({ task: "Event at capacity" }),
    { code: "FORK_LIMIT" },
  );
  assert.equal(f.children.size, 8);
  f.children.get("fork-1")!.finish("Complete");
  await settle();
  await f.tools.fork("Capacity freed");
  await f.family.abort();
});

test("fork failures wake the parent with safe diagnostics; restored histories stay stopped until messaged", async () => {
  const f = fixture();
  const child = await f.tools.fork("Fail");
  f.children.get(child.id)!.fail();
  await settle();
  assert.match(f.main.prompts[0]!, /could not finish/);
  assert.doesNotMatch(f.main.prompts[0]!, /secret provider/);
  const saved = controlled("saved-fork");
  f.family.restore(saved.session, "main");
  assert.equal(
    f.tools.list().find((fork) => fork.id === "saved-fork")!.status,
    "stopped",
  );
  assert.equal(saved.prompts.length, 0);
  assert.equal(
    f.family.background.activeCount,
    0,
    "failed and restored sessions are not active",
  );
  f.tools.send("saved-fork", "Continue");
  assert.match(saved.prompts[0]!, /Continue/);
  assert.equal(f.family.background.activeCount, 1);
  await f.family.abort();
});

test("a fork opening during shutdown is disposed before it can start", async () => {
  const main = controlled("root");
  const child = controlled("late");
  let open!: (session: ForkableSession) => void;
  const family = new ForkingAgentSession(main.session, {
    /** Hold creation across shutdown to exercise late resource cleanup. */
    create: () =>
      new Promise((resolve) => {
        open = resolve;
      }),
  });
  const creating = family.operations("main").fork("Late task");
  const rejected = assert.rejects(creating, { code: "FORK_UNAVAILABLE" });
  await family.abort();
  await family.dispose();
  open(child.session);
  await rejected;
  assert.equal(child.state().disposed, true);
  assert.equal(child.prompts.length, 0);
});

test("messages wait at capacity and wake as soon as another fork releases its slot", async () => {
  const f = fixture();
  const saved = controlled("saved-fork");
  f.family.restore(saved.session, "main");
  for (let i = 0; i < 8; i++) await f.tools.fork(`Task ${i}`);
  f.tools.send("saved-fork", "Queued at capacity");
  assert.equal(saved.prompts.length, 0);
  assert.equal(
    f.family.background.activeCount,
    8,
    "queued work does not increase the running count",
  );
  assert.equal(
    f.tools.list().find((fork) => fork.id === "saved-fork")!.status,
    "queued",
  );
  f.children.get("fork-1")!.finish("A slot is free");
  await settle();
  assert.match(saved.prompts[0]!, /Queued at capacity/);
  assert.equal(
    f.tools.list().filter((fork) => fork.status === "running").length,
    8,
  );
  await f.family.abort();
});

test("an early progress message does not suppress the outcome after further work", async () => {
  const f = fixture();
  const child = await f.tools.fork("Work after progress");
  const worker = f.children.get(child.id)!;
  f.family.operations(child.id).send("parent", "Starting");
  worker.used("send_message");
  f.main.finish();
  await settle();
  worker.used("bash");
  worker.finish("The completed result");
  await settle();
  assert.match(f.main.prompts[1]!, /The completed result/);
  await f.family.abort();
});

test("a fork receiving messages during cancellation cannot resume before Stop completes", async () => {
  const f = fixture();
  const child = await f.tools.fork("Stop this task");
  const sibling = await f.tools.fork("Continue this task");
  const stopping = f.tools.stop(child.id);
  assert.throws(() => f.family.operations(sibling.id).send(child.id, "late"), {
    code: "FORK_UNAVAILABLE",
  });
  await stopping;
  assert.equal(
    f.tools.list().find((fork) => fork.id === child.id)!.status,
    "stopped",
  );
  assert.equal(f.children.get(child.id)!.prompts.length, 1);
  await f.family.abort();
});

test("a main turn awakened by a fork exposes safe failure status and can recover", async () => {
  const f = fixture();
  const runtime = new AgentRuntime(f.family);
  const child = await f.tools.fork("Work");
  f.children.get(child.id)!.finish("Result");
  await settle();
  f.main.fail();
  await settle();
  assert.equal(runtime.status.status, "error");
  assert.doesNotMatch(runtime.status.error!, /secret provider/);
  await runtime.stop();
  runtime.start("Try again");
  f.main.finish();
  await settle();
  assert.equal(runtime.status.status, "idle");
  await runtime.close();
});

test("wakeup routes the result before deleting its subtree and preserves ordinary subagents", async () => {
  const f = fixture();
  const retained = await f.family.subagents!.create({
    task: "Keep this session",
  });
  const event = await f.family.subagents!.wakeup({ task: "Handle event" });
  const nested = await f.family.operations(event.id).fork("Supporting work");
  assert.equal(f.family.subagents!.list().length, 3);
  assert.match(
    f.children.get(event.id)!.prompts[0]!,
    /Background task from API event:\nHandle event/,
  );
  f.children.get(event.id)!.finish("Event result");
  await settle();
  assert.match(f.main.prompts[0]!, /Event result/);
  assert.equal(f.main.state().running, true);
  assert.equal(f.main.state().aborts, 0);
  assert.deepEqual(
    f.family.subagents!.list().map((item) => item.id),
    [retained.id],
  );
  assert.deepEqual(f.removed, [event.id, nested.id]);
  for (const id of [event.id, nested.id])
    assert.equal(f.children.get(id)!.state().disposed, true);
  assert.equal(f.children.get(retained.id)!.state().disposed, false);
  assert.throws(() => f.family.subagents!.messages(event.id), {
    code: "SUBAGENT_NOT_FOUND",
  });
  await f.family.abort();
});

test("wakeup waits for queued turns to finish and can finish silently", async () => {
  const f = fixture();
  const event = await f.family.subagents!.wakeup({ task: "Check event" });
  const worker = f.children.get(event.id)!;
  f.family.subagents!.send(event.id, "Followup while working");
  worker.finish("");
  await settle();
  assert.equal(worker.prompts.length, 2);
  assert.equal(f.family.subagents!.list().length, 1);
  assert.equal(worker.state().disposed, false);
  worker.finish("");
  await settle();
  assert.equal(f.main.prompts.length, 0);
  assert.equal(f.family.subagents!.list().length, 0);
  assert.deepEqual(f.removed, [event.id]);
  await f.family.abort();
});

for (const ending of [
  "error",
  "stop",
  "shutdown",
  "tool stop",
  "delete",
] as const) {
  test(`wakeup cleans up on ${ending} without duplicate deletion or late replies`, async () => {
    const f = fixture();
    const event = await f.family.subagents!.wakeup({ task: "Handle event" });
    const worker = f.children.get(event.id)!;
    if (ending === "error") worker.fail();
    else if (ending === "stop") await f.family.abort();
    else if (ending === "shutdown") await f.family.dispose();
    else if (ending === "tool stop") await f.tools.stop(event.id);
    else await f.family.subagents!.delete(event.id);
    await settle();
    assert.equal(f.family.subagents!.list().length, 0);
    assert.equal(worker.state().disposed, true);
    assert.deepEqual(f.removed, [event.id]);
    assert.equal(f.main.prompts.length, ending === "error" ? 1 : 0);
    assert.doesNotMatch(
      f.main.prompts.join("\n"),
      /secret provider|send the fork another message/,
    );
    await f.family.abort();
  });
}

test("overlapping descendant deletion and wakeup cleanup share teardown", async () => {
  const f = fixture();
  const event = await f.family.subagents!.wakeup({ task: "Handle event" });
  const child = await f.family.operations(event.id).fork("Child");
  const deleting = f.family.subagents!.delete(child.id);
  f.children.get(event.id)!.finish();
  await deleting;
  await settle();
  assert.deepEqual([...f.removed].sort(), [event.id, child.id].sort());
  assert.equal(f.family.subagents!.list().length, 0);
  await f.family.abort();
});
