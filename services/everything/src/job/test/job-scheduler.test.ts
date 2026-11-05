import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationError } from "@everything/errors";
import { ForkLimitError } from "../../runtime/error/fork-errors.js";
import { ProviderInactiveError } from "../../provider/error/provider-errors.js";
import {
  JobRunActiveError,
  JobSchedulePassedError,
} from "../error/job-errors.js";
import type { JobSchedule } from "../model/job.js";
import { jobRunErrors } from "../model/job-dispatch.js";
import { JobRuns, type JobWakeups } from "../service/job-runs.js";
import { JobScheduler } from "../service/job-scheduler.js";
import { JobService } from "../service/job-service.js";
import {
  FakeClock,
  FakeWakeups,
  fixtureAgents,
  MemoryJobs,
  settle,
  teammates,
} from "./job-fixtures.js";

const scope = { ownerId: "owner", agentId: teammates.avery } as const;
const fifteenMinutes = 15 * 60_000;

/** Real scheduler, dispatcher, and service over in-memory storage, a fake runtime, and a manual clock. */
function fixture(wakeups: JobWakeups = new FakeWakeups()) {
  const clock = new FakeClock();
  const store = new MemoryJobs(clock.now);
  const failures: string[] = [];
  const runs = new JobRuns(
    wakeups,
    store,
    () => failures.push("failure"),
    { retries: 3, minRetryMs: 5, maxRetryMs: 5 },
    clock.now,
  );
  const scheduler = new JobScheduler(
    store,
    runs,
    () => failures.push("scheduler"),
    clock.now,
  );
  const service = new JobService(fixtureAgents(), store, runs, clock.now);
  return {
    clock,
    store,
    runs,
    scheduler,
    service,
    failures,
    wakeups: wakeups as FakeWakeups,
    /** Create a job for Avery. */
    create(schedule: JobSchedule, name = "Check the build") {
      return service.create(scope, {
        name,
        instructions: "Look at the latest CI run and tell main if it failed.",
        schedule,
      });
    },
    /** Run one scheduler check and let dispatch settle. */
    async tick() {
      await scheduler.refresh();
      await settle();
    },
  };
}

test("a due run is accepted through the normal wakeup and is running, not completed, until its session ends", async () => {
  const f = fixture();
  const job = await f.create({ type: "interval", seconds: 900 });
  assert.equal(job.nextRunAt, "2026-11-05T10:15:00.000Z");
  await f.tick();
  assert.equal(f.wakeups.accepted.length, 0, "nothing is due yet");

  f.clock.advance(fifteenMinutes + 2_000);
  await f.tick();
  assert.equal(f.wakeups.accepted.length, 1);
  const wakeup = f.wakeups.last;
  assert.deepEqual(wakeup.scope, scope);
  assert.equal(wakeup.context, false, "fresh context");
  assert.equal(wakeup.options?.source, "scheduled job");
  assert.match(
    wakeup.task,
    /Scheduled job "Check the build", which runs every 15 minutes/,
  );
  assert.match(wakeup.task, /This run was due at 2026-11-05T10:15:00.000Z/);
  assert.match(wakeup.task, /Look at the latest CI run/);
  assert.match(wakeup.task, /final reply goes to your main conversation/);

  const [run] = f.store.runsOf(job.id);
  assert.equal(run!.status, "running", "accepted is not completed");
  assert.equal(run!.scheduledFor, "2026-11-05T10:15:00.000Z");
  assert.equal(run!.startedAt, "2026-11-05T10:15:02.000Z");
  assert.equal(run!.finishedAt, null);
  // The grid is anchored at the due time, not the late dispatch.
  assert.equal(f.store.jobs.get(job.id)!.nextRunAt, "2026-11-05T10:30:00.000Z");

  f.clock.advance(40_000);
  f.wakeups.end(wakeup.id, "completed");
  await settle();
  assert.deepEqual(
    { ...f.store.run(run!.id), id: undefined, jobId: undefined },
    {
      id: undefined,
      jobId: undefined,
      scheduledFor: "2026-11-05T10:15:00.000Z",
      status: "completed",
      startedAt: "2026-11-05T10:15:02.000Z",
      finishedAt: "2026-11-05T10:15:42.000Z",
      error: null,
    },
  );
  assert.deepEqual(f.failures, []);
});

test("failed and cancelled sessions record safe reasons", async () => {
  const f = fixture();
  const job = await f.create({ type: "interval", seconds: 300 });
  f.clock.advance(300_000);
  await f.tick();
  f.wakeups.end(f.wakeups.last.id, "failed");
  await settle();
  assert.equal(f.store.runsOf(job.id)[0]!.status, "failed");
  assert.equal(f.store.runsOf(job.id)[0]!.error, jobRunErrors.turnFailed);

  f.clock.advance(300_000);
  await f.tick();
  // For example, the teammate's Stop button removed the session.
  f.wakeups.end(f.wakeups.last.id, "cancelled");
  await settle();
  assert.equal(f.store.runsOf(job.id)[0]!.status, "cancelled");
  assert.equal(f.store.runsOf(job.id)[0]!.error, jobRunErrors.stopped);
  assert.equal(f.store.runsOf(job.id).length, 2);
});

test("downtime coalesces missed occurrences into one run, then the next future time", async () => {
  const f = fixture();
  const job = await f.create({ type: "interval", seconds: 900 });
  f.clock.advance(3 * 60 * 60_000 + 5 * 60_000);
  await f.tick();
  await f.tick();
  assert.equal(f.wakeups.accepted.length, 1, "one catch-up run, not twelve");
  assert.equal(
    f.store.runsOf(job.id)[0]!.scheduledFor,
    "2026-11-05T10:15:00.000Z",
  );
  assert.equal(f.store.jobs.get(job.id)!.nextRunAt, "2026-11-05T13:15:00.000Z");
  f.wakeups.end(f.wakeups.last.id, "completed");
  await settle();
  await f.tick();
  assert.equal(f.wakeups.accepted.length, 1, "the next time is in the future");
});

test("runs never overlap: an occurrence due during a run waits, then runs once", async () => {
  const f = fixture();
  const job = await f.create({ type: "interval", seconds: 300 });
  f.clock.advance(300_000);
  await f.tick();
  const first = f.wakeups.last;
  f.clock.advance(20 * 60_000);
  await f.tick();
  await f.tick();
  assert.equal(
    f.wakeups.accepted.length,
    1,
    "no second run while one is active",
  );
  assert.equal(f.store.runsOf(job.id).length, 1);

  f.wakeups.end(first.id, "completed");
  await settle();
  await f.tick();
  assert.equal(f.wakeups.accepted.length, 2);
  const [latest] = f.store.runsOf(job.id);
  // The waiting occurrence keeps its own due time; the job then moves past now.
  assert.equal(latest!.scheduledFor, "2026-11-05T10:10:00.000Z");
  assert.equal(f.store.jobs.get(job.id)!.nextRunAt, "2026-11-05T10:30:00.000Z");
});

test("a one-time job runs once, disables itself, and isn't revived by a restart", async () => {
  const f = fixture();
  const job = await f.create({ type: "once", at: "2026-11-05T11:00:00Z" });
  f.clock.set("2026-11-05T11:00:01Z");
  await f.tick();
  assert.equal(f.wakeups.accepted.length, 1);
  assert.match(
    f.wakeups.last.task,
    /which runs once, at 2026-11-05T11:00:00.000Z/,
  );
  const saved = f.store.jobs.get(job.id)!;
  assert.equal(saved.enabled, false);
  assert.equal(saved.nextRunAt, "2026-11-05T11:00:00.000Z", "the time is kept");
  assert.equal((await f.service.get(scope, job.id)).nextRunAt, null);

  // The process restarts while the run is in progress; a new process recovers the store.
  const restarted = new JobScheduler(
    f.store,
    new JobRuns(f.wakeups, f.store, () => {}),
    () => {},
    f.clock.now,
  );
  assert.equal(await restarted.recover(), 1);
  const [run] = f.store.runsOf(job.id);
  assert.equal(run!.status, "failed");
  assert.equal(run!.error, jobRunErrors.restarted);
  await restarted.refresh();
  await settle();
  assert.equal(f.wakeups.accepted.length, 1, "not replayed");

  await assert.rejects(
    f.service.update(scope, job.id, { enabled: true }),
    JobSchedulePassedError,
  );
  // A new future time alone doesn't turn it back on; resuming is explicit.
  const rescheduled = await f.service.update(scope, job.id, {
    schedule: { type: "once", at: "2026-11-06T09:00:00Z" },
  });
  assert.equal(rescheduled.enabled, false);
  const resumed = await f.service.update(scope, job.id, { enabled: true });
  assert.equal(resumed.nextRunAt, "2026-11-06T09:00:00.000Z");
});

test("pausing withdraws a run not yet accepted and blocks later runs; a running run continues", async () => {
  const f = fixture();
  const job = await f.create({ type: "interval", seconds: 300 });
  f.clock.advance(300_000);
  // The teammate's eight background slots are full, so the wakeup waits to retry.
  f.wakeups.refuse(new ForkLimitError());
  await f.scheduler.refresh();
  await f.service.update(scope, job.id, { enabled: false });
  await f.runs.settled();
  assert.equal(f.wakeups.accepted.length, 0);
  assert.equal(f.wakeups.refusedCount.value, 1, "no retry after the pause");
  assert.equal(f.store.runsOf(job.id)[0]!.status, "cancelled");
  assert.equal(
    f.store.runsOf(job.id)[0]!.error,
    jobRunErrors.pausedBeforeStart,
  );

  f.clock.advance(60 * 60_000);
  await f.tick();
  assert.equal(f.wakeups.accepted.length, 0, "paused jobs aren't due");

  // Resuming restarts the grid from now rather than running the missed hour.
  const resumed = await f.service.update(scope, job.id, { enabled: true });
  assert.equal(resumed.nextRunAt, "2026-11-05T11:10:00.000Z");
  f.clock.advance(300_000);
  await f.tick();
  assert.equal(f.wakeups.accepted.length, 1);
  await f.service.update(scope, job.id, { enabled: false });
  await settle();
  assert.equal(
    f.store.runsOf(job.id)[0]!.status,
    "running",
    "pause isn't stop",
  );
  f.wakeups.end(f.wakeups.last.id, "completed");
  await settle();
  assert.equal(f.store.runsOf(job.id)[0]!.status, "completed");
});

test("stopping a job ends only its run, and deleting a job stops its run and removes its history", async () => {
  const f = fixture();
  const build = await f.create({ type: "interval", seconds: 300 }, "Build");
  const inbox = await f.create({ type: "interval", seconds: 300 }, "Inbox");
  f.clock.advance(300_000);
  await f.tick();
  const [buildRun, inboxRun] = f.wakeups.accepted;
  assert.ok(buildRun && inboxRun);

  await f.service.stop(scope, build.id);
  await settle();
  assert.deepEqual(f.wakeups.deleted, [buildRun.id]);
  assert.equal(f.store.runsOf(build.id)[0]!.status, "cancelled");
  assert.equal(f.store.runsOf(build.id)[0]!.error, jobRunErrors.stoppedFromJob);
  assert.equal(f.store.runsOf(inbox.id)[0]!.status, "running");
  assert.equal(f.store.jobs.get(build.id)!.enabled, true, "stop isn't pause");
  // Stopping again with nothing running is harmless.
  await f.service.stop(scope, build.id);

  await f.service.delete(scope, inbox.id);
  await f.runs.settled();
  assert.deepEqual(f.wakeups.deleted, [buildRun.id, inboxRun.id]);
  assert.equal(f.store.jobs.has(inbox.id), false);
  assert.deepEqual(f.store.runsOf(inbox.id), []);
});

test("full slots are retried briefly; other refusals and unexpected errors end the run without a retry", async () => {
  const f = fixture();
  const job = await f.create({ type: "interval", seconds: 300 });
  f.clock.advance(300_000);
  f.wakeups.refuse(new ForkLimitError(), new ForkLimitError());
  await f.scheduler.refresh();
  await f.runs.settled();
  assert.equal(f.wakeups.refusedCount.value, 2);
  assert.equal(f.store.runsOf(job.id)[0]!.status, "running");
  f.wakeups.end(f.wakeups.last.id, "completed");
  await settle();

  /** Dispatch one manual run and wait for it to be refused or accepted. */
  async function runNowWith(...errors: unknown[]) {
    f.wakeups.refuse(...errors);
    const before = f.wakeups.refusedCount.value;
    f.clock.advance(1_000);
    const run = await f.service.runNow(scope, job.id);
    await f.runs.settled();
    return {
      run: f.store.run(run.id),
      attempts: f.wakeups.refusedCount.value - before,
    };
  }
  const inactive = await runNowWith(new ProviderInactiveError());
  assert.equal(inactive.attempts, 1);
  assert.equal(inactive.run.status, "failed");
  assert.match(inactive.run.error!, /model provider isn't connected/);
  assert.equal(inactive.run.startedAt, null);

  // An unexpected error might hide an acceptance, so it is never sent again.
  const unexpected = await runNowWith(new Error("socket hang up"));
  assert.equal(unexpected.attempts, 1);
  assert.equal(unexpected.run.error, jobRunErrors.unexpected);

  const full = await runNowWith(
    ...Array.from({ length: 4 }, () => new ForkLimitError()),
  );
  assert.equal(full.attempts, 4, "one try and three retries");
  assert.match(full.run.error!, /eight background tasks/);

  const custom = await runNowWith(
    new ApplicationError(409, "OTHER", "Plain reason."),
  );
  assert.equal(custom.run.error, "Didn't start: Plain reason.");
  assert.equal(f.wakeups.accepted.length, 1);
});

test("a stop that races acceptance removes the session the teammate just started", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inner = new FakeWakeups();
  const f = fixture({
    // The service already checked the signal under the teammate lock, then accepts after the stop.
    wakeup: async (target, input, _signal, options) => {
      await gate;
      return inner.wakeup(target, input, undefined, options);
    },
    delete: (target, id) => inner.delete(target, id),
  });
  const job = await f.create({ type: "interval", seconds: 300 });
  const run = await f.service.runNow(scope, job.id);
  await f.service.stop(scope, job.id);
  assert.equal(f.store.run(run.id).status, "pending");
  release();
  await f.runs.settled();
  assert.equal(inner.accepted.length, 1);
  assert.deepEqual(inner.deleted, [inner.accepted[0]!.id]);
  assert.equal(f.store.run(run.id).status, "cancelled");
  assert.equal(f.store.run(run.id).error, jobRunErrors.stoppedFromJob);
  assert.ok(f.store.run(run.id).startedAt, "it did start");
});

test("shutdown withdraws unaccepted runs and records accepted ones cancelled by shutdown", async () => {
  const inner = new FakeWakeups();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  const f = fixture({
    // The second wakeup waits for the teammate lock; it honors its signal once it gets it.
    wakeup: async (target, input, signal, options) => {
      if (inner.accepted.length) {
        held = true;
        await gate;
      }
      return inner.wakeup(target, input, signal, options);
    },
    delete: (target, id) => inner.delete(target, id),
  });
  const running = await f.create({ type: "interval", seconds: 300 }, "Running");
  const waiting = await f.create({ type: "interval", seconds: 300 }, "Waiting");
  const accepted = await f.service.runNow(scope, running.id);
  await settle();
  const unaccepted = await f.service.runNow(scope, waiting.id);
  await settle();
  assert.ok(held);

  const closing = f.runs.close();
  release();
  // The runtime closes after the dispatcher and removes the accepted session.
  inner.end(inner.accepted[0]!.id, "cancelled");
  await closing;
  await f.runs.settled();
  assert.equal(f.store.run(accepted.id).status, "cancelled");
  assert.equal(f.store.run(accepted.id).error, jobRunErrors.shutdown);
  assert.equal(f.store.run(unaccepted.id).status, "cancelled");
  assert.equal(f.store.run(unaccepted.id).error, jobRunErrors.shutdown);
  assert.equal(inner.accepted.length, 1);
});

test("two schedulers checking the same due job record and dispatch one occurrence", async () => {
  const f = fixture();
  const job = await f.create({ type: "interval", seconds: 300 });
  const second = new JobScheduler(
    f.store,
    new JobRuns(f.wakeups, f.store, () => {}),
    () => {},
    f.clock.now,
  );
  f.clock.advance(300_000);
  await Promise.all([f.scheduler.refresh(), second.refresh()]);
  await settle();
  assert.equal(f.store.runsOf(job.id).length, 1);
  assert.equal(f.wakeups.accepted.length, 1);
  assert.deepEqual(f.failures, []);
});

test("run now is a separate occurrence, works while paused, keeps the schedule, and never overlaps", async () => {
  const f = fixture();
  const job = await f.create({ type: "interval", seconds: 3600 });
  await f.service.update(scope, job.id, { enabled: false });
  f.clock.advance(1_000);
  const run = await f.service.runNow(scope, job.id);
  assert.equal(run.status, "pending");
  assert.equal(run.scheduledFor, "2026-11-05T10:00:01.000Z");
  await settle();
  assert.match(
    f.wakeups.last.task,
    /started this run with Run now at 2026-11-05T10:00:01.000Z/,
  );
  await assert.rejects(f.service.runNow(scope, job.id), JobRunActiveError);
  const saved = f.store.jobs.get(job.id)!;
  assert.equal(saved.enabled, false);
  assert.equal(saved.nextRunAt, "2026-11-05T11:00:00.000Z");
});

test("edits keep the next time unless the schedule changes, and stale due work can't revive a deleted job", async () => {
  const f = fixture();
  const job = await f.create({ type: "interval", seconds: 900 });
  f.clock.advance(60_000);
  const renamed = await f.service.update(scope, job.id, {
    name: "  Check CI  ",
    instructions: "Only failures.",
    schedule: { type: "interval", seconds: 900 },
  });
  assert.equal(renamed.name, "Check CI");
  assert.equal(renamed.nextRunAt, job.nextRunAt, "same schedule, same time");
  assert.equal(renamed.updatedAt, "2026-11-05T10:01:00.000Z");
  const moved = await f.service.update(scope, job.id, {
    schedule: {
      type: "cron",
      expression: "30 18 * * *",
      timezone: "Europe/Paris",
    },
  });
  assert.equal(moved.nextRunAt, "2026-11-05T17:30:00.000Z");

  // The scheduler read the due list before the job was deleted.
  f.clock.set("2026-11-05T17:31:00Z");
  const due = await f.store.due({ ownership: "all" }, f.clock.now(), 20);
  assert.equal(due.length, 1);
  await f.service.delete(scope, job.id);
  await f.tick();
  assert.equal(f.wakeups.accepted.length, 0);
});
