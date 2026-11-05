import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForkableSession } from "../../runtime/interface/session-forks.js";
import { ForkingAgentSession } from "../../runtime/service/forking-agent-session.js";
import { SubagentService } from "../../subagent/service/subagent-service.js";
import { jobRunErrors } from "../model/job-dispatch.js";
import { JobRuns } from "../service/job-runs.js";
import { JobService } from "../service/job-service.js";
import {
  FakeClock,
  fixtureAgents,
  MemoryJobs,
  settle,
  teammates,
} from "./job-fixtures.js";

const scope = { ownerId: "owner", agentId: teammates.avery } as const;

/** A model session whose turns stay open until the test finishes or fails them. */
function controlled(id: string) {
  const prompts: string[] = [];
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let output: string | undefined;
  let disposed = false;
  const session: ForkableSession = {
    id,
    compacting: false,
    compactionStartedAt: null,
    typing: false,
    lastToolName: undefined,
    /** The latest completed reply. */
    get lastResponse() {
      return output;
    },
    /** Hold the turn open. */
    async prompt(text) {
      prompts.push(text);
      await new Promise<void>((done, failed) => {
        resolve = done;
        reject = failed;
      });
    },
    /** Release the turn on cancellation. */
    async abort() {
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
    /** End the turn normally with this reply. */
    finish(text: string) {
      output = text;
      const done = resolve;
      resolve = undefined;
      done?.();
    },
    /** End the turn with a provider error that must stay private. */
    fail() {
      const failed = reject;
      resolve = undefined;
      failed?.(new Error("secret provider response"));
    },
    /** Whether a turn is open or the session was released. */
    state() {
      return { running: resolve !== undefined, disposed };
    },
  };
}

/** A real session family and subagent service with controllable model turns, plus the job stack. */
function fixture() {
  const clock = new FakeClock();
  const main = controlled("main");
  const children: ReturnType<typeof controlled>[] = [];
  const removed: string[] = [];
  const family = new ForkingAgentSession(
    main.session,
    {
      async create() {
        const child = controlled(`fork-${children.length + 1}`);
        children.push(child);
        return child.session;
      },
    },
    () => 0,
    {
      messages: () => ({ messages: [], nextCursor: null }),
      remove: async (ids) => {
        removed.push(...ids);
      },
    },
  );
  // The conversation service's ownership lock is out of scope here; the family is Avery's.
  const subagents = new SubagentService(
    {
      withSubagents: async (target, _load, operation) => {
        assert.deepEqual(target, scope);
        return operation(family.subagents);
      },
    },
    { open: async () => assert.fail("archives aren't used") },
  );
  const store = new MemoryJobs(clock.now);
  const failures: unknown[] = [];
  const runs = new JobRuns(
    subagents,
    store,
    () => failures.push("failure"),
    { retries: 0, minRetryMs: 0, maxRetryMs: 0 },
    clock.now,
  );
  const service = new JobService(fixtureAgents(), store, runs, clock.now);
  return {
    clock,
    main,
    children,
    removed,
    family,
    store,
    runs,
    service,
    failures,
  };
}

test("a job run is pending until accepted, running while its session works, and completed only after removal", async () => {
  const f = fixture();
  const job = await f.service.create(scope, {
    name: "Release notes",
    instructions: "Check for a new release and summarize it.",
    schedule: { type: "interval", seconds: 3600 },
  });
  const run = await f.service.runNow(scope, job.id);
  assert.equal(run.status, "pending", "the API returns before acceptance");
  await settle();

  const [child] = f.children;
  assert.ok(child);
  assert.match(
    child.prompts[0]!,
    /^Background task from scheduled job:\nScheduled job "Release notes"/,
  );
  assert.equal(f.store.run(run.id).status, "running");
  assert.equal(f.main.prompts.length, 0, "main isn't woken by acceptance");

  // Saying nothing was found is ordinary completed output, not a failure.
  child.finish("No new release today.");
  await settle();
  assert.deepEqual(
    f.removed,
    [child.session.id],
    "the temporary subtree is removed",
  );
  assert.equal(f.store.run(run.id).status, "completed");
  assert.equal(f.store.run(run.id).error, null);
  // The reply reaches main through ordinary private delivery and isn't stored on the run.
  assert.equal(
    f.main.prompts[0],
    `Fork ${child.session.id} finished:\nNo new release today.`,
  );
  assert.ok(!JSON.stringify(f.store.runRecords).includes("No new release"));
  assert.deepEqual(f.failures, []);
});

test("a provider failure during the run is recorded as failed with a safe reason", async () => {
  const f = fixture();
  const job = await f.service.create(scope, {
    name: "Inbox",
    instructions: "Check the inbox.",
    schedule: { type: "interval", seconds: 3600 },
  });
  const run = await f.service.runNow(scope, job.id);
  await settle();
  f.children[0]!.fail();
  await settle();
  assert.equal(f.store.run(run.id).status, "failed");
  assert.equal(f.store.run(run.id).error, jobRunErrors.turnFailed);
  assert.ok(!JSON.stringify(f.store.runRecords).includes("secret"));
});

test("stopping a job removes only its subtree; main and an ordinary fork keep working", async () => {
  const f = fixture();
  const ordinary = await f.family.operations("main").fork("Long research");
  const job = await f.service.create(scope, {
    name: "Build",
    instructions: "Check the build.",
    schedule: { type: "interval", seconds: 3600 },
  });
  const run = await f.service.runNow(scope, job.id);
  await settle();
  const [research, jobFork] = f.children;
  assert.ok(research && jobFork);

  await f.service.stop(scope, job.id);
  await settle();
  assert.deepEqual(f.removed, [jobFork.session.id]);
  assert.equal(jobFork.state().disposed, true);
  assert.equal(research.state().running, true, "unrelated work continues");
  assert.equal(
    f.family.subagents!.list().find((fork) => fork.id === ordinary.id)?.status,
    "running",
  );
  assert.equal(f.store.run(run.id).status, "cancelled");
  assert.equal(f.store.run(run.id).error, jobRunErrors.stoppedFromJob);
  assert.ok(f.store.run(run.id).startedAt);
});

test("the teammate's Stop cancels the current run but not the job; its next run wakes the teammate again", async () => {
  const f = fixture();
  const job = await f.service.create(scope, {
    name: "Build",
    instructions: "Check the build.",
    schedule: { type: "interval", seconds: 3600 },
  });
  const first = await f.service.runNow(scope, job.id);
  await settle();
  await f.family.abort("all");
  await settle();
  assert.equal(f.store.run(first.id).status, "cancelled");
  assert.equal(f.store.run(first.id).error, jobRunErrors.stopped);
  assert.equal((await f.service.get(scope, job.id)).enabled, true);

  // Like every wakeup, a later run resumes a stopped family; pausing the job is what prevents it.
  f.clock.advance(1_000);
  const second = await f.service.runNow(scope, job.id);
  await settle();
  assert.equal(f.store.run(second.id).status, "running");
  assert.equal(f.children.length, 2);
});

test("a temporary session woken again by its child finishes with its last turn", async () => {
  const f = fixture();
  const job = await f.service.create(scope, {
    name: "Deep check",
    instructions: "Fork a helper, then report.",
    schedule: { type: "interval", seconds: 3600 },
  });
  const run = await f.service.runNow(scope, job.id);
  await settle();
  const jobFork = f.children[0]!;
  // The job's session starts a helper; the helper's reply queues another turn for it.
  const helper = await f.family
    .operations(jobFork.session.id)
    .fork("Look deeper");
  await settle();
  f.children[1]!.finish("Helper found one issue.");
  await settle();
  assert.equal(f.store.run(run.id).status, "running");
  jobFork.finish("Started a helper.");
  await settle();
  assert.equal(
    f.store.run(run.id).status,
    "running",
    "its next turn is queued",
  );
  jobFork.finish("One issue: the cache is stale.");
  await settle();
  assert.equal(f.store.run(run.id).status, "completed");
  assert.ok(
    f.removed.includes(jobFork.session.id) && f.removed.includes(helper.id),
  );
});
