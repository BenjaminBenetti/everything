import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { jobController } from "../controller/job-controller.js";
import { jobLimits } from "../model/job.js";
import { jobRunErrors } from "../model/job-dispatch.js";
import { JobRuns } from "../service/job-runs.js";
import { JobService } from "../service/job-service.js";
import {
  FakeClock,
  FakeWakeups,
  fixtureAgents,
  MemoryJobs,
  settle,
  teammates,
} from "./job-fixtures.js";

const avery = `/agents/${teammates.avery}/jobs`;
const blake = `/agents/${teammates.blake}/jobs`;
const foreign = `/agents/${teammates.foreign}/jobs`;
const weekdays = {
  type: "cron",
  expression: "0 9 * * 1-5",
  timezone: "Europe/Paris",
} as const;

/** The production controller and service over in-memory storage and a fake runtime. */
async function fixture() {
  const clock = new FakeClock("2026-11-05T10:00:00.000Z");
  const store = new MemoryJobs(clock.now);
  const wakeups = new FakeWakeups();
  const runs = new JobRuns(
    wakeups,
    store,
    () => {},
    { retries: 0, minRetryMs: 0, maxRetryMs: 0 },
    clock.now,
  );
  const app = authenticatedTestServer();
  await jobController(
    app,
    new JobService(fixtureAgents(), store, runs, clock.now),
  );
  return { app, clock, store, wakeups, runs };
}

test("owners create, list, read, change, pause, and delete a teammate's jobs", async (context) => {
  const { app, clock } = await fixture();
  context.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: avery,
    payload: {
      name: "Morning PRs",
      instructions: "List open PRs that need my review.",
      schedule: weekdays,
    },
  });
  assert.equal(created.statusCode, 201);
  const job = created.json();
  assert.deepEqual(
    { ...job, id: undefined },
    {
      id: undefined,
      agentId: teammates.avery,
      name: "Morning PRs",
      instructions: "List open PRs that need my review.",
      schedule: weekdays,
      nextRunAt: "2026-11-06T08:00:00.000Z",
      enabled: true,
      createdAt: "2026-11-05T10:00:00.000Z",
      updatedAt: "2026-11-05T10:00:00.000Z",
      latestRun: null,
    },
  );
  const listed = await app.inject({ method: "GET", url: avery });
  assert.deepEqual(listed.json(), { jobs: [job] });
  assert.deepEqual(
    (await app.inject({ method: "GET", url: `${avery}/${job.id}` })).json(),
    job,
  );

  clock.advance(60_000);
  const paused = await app.inject({
    method: "PATCH",
    url: `${avery}/${job.id}`,
    payload: { enabled: false },
  });
  assert.equal(paused.statusCode, 200);
  assert.equal(paused.json().enabled, false);
  assert.equal(paused.json().nextRunAt, null);
  assert.equal(paused.json().updatedAt, "2026-11-05T10:01:00.000Z");

  const resumed = await app.inject({
    method: "PATCH",
    url: `${avery}/${job.id}`,
    payload: { enabled: true, schedule: { type: "interval", seconds: 1800 } },
  });
  assert.equal(resumed.json().nextRunAt, "2026-11-05T10:31:00.000Z");

  const deleted = await app.inject({
    method: "DELETE",
    url: `${avery}/${job.id}`,
  });
  assert.equal(deleted.statusCode, 204);
  const missing = await app.inject({
    method: "GET",
    url: `${avery}/${job.id}`,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "JOB_NOT_FOUND");
});

test("jobs of another owner's teammate, or another teammate, look missing on every route", async (context) => {
  const { app, store } = await fixture();
  context.after(() => app.close());
  const blakeJob = (
    await app.inject({
      method: "POST",
      url: blake,
      payload: {
        name: "Blake's job",
        instructions: "Check.",
        schedule: { type: "interval", seconds: 900 },
      },
    })
  ).json();
  const other = await store.create(
    { ownerId: "other", agentId: teammates.foreign },
    {
      name: "Other owner's",
      instructions: "Check.",
      schedule: { type: "interval", seconds: 900 },
      nextRunAt: "2026-11-05T10:15:00.000Z",
      enabled: true,
    },
  );
  const routes = (url: string) =>
    [
      ["GET", url],
      ["PATCH", url, { name: "Taken" }],
      ["DELETE", url],
      ["GET", `${url}/runs`],
      ["POST", `${url}/runs`],
      ["POST", `${url}/stop`],
    ] as const;
  // Blake's job through Avery's address, a random job, and the other owner's job by both addresses.
  for (const url of [
    `${avery}/${blakeJob.id}`,
    `${avery}/${randomUUID()}`,
    `${avery}/${other.id}`,
  ])
    for (const [method, target, payload] of routes(url)) {
      const response = await app.inject({
        method,
        url: target,
        ...(payload ? { payload } : {}),
      });
      assert.equal(response.statusCode, 404, `${method} ${target}`);
      assert.equal(response.json().code, "JOB_NOT_FOUND");
    }
  for (const [method, target, payload] of [
    ...routes(`${foreign}/${other.id}`),
    ["GET", foreign],
    ["POST", foreign, { name: "x", instructions: "y", schedule: weekdays }],
    ["POST", `${foreign}/preview`, { schedule: weekdays }],
  ] as const) {
    const response = await app.inject({
      method,
      url: target,
      ...(payload ? { payload } : {}),
    });
    assert.equal(response.statusCode, 404, `${method} ${target}`);
    assert.equal(response.json().code, "AGENT_NOT_FOUND");
  }
  assert.equal(store.jobs.get(blakeJob.id)!.name, "Blake's job");
  assert.equal(store.jobs.get(other.id)!.name, "Other owner's");
  assert.equal(store.runRecords.length, 0);
});

test("requests are strict: unknown schedule types or fields, bounds, and invalid schedules are refused", async (context) => {
  const { app, store } = await fixture();
  context.after(() => app.close());
  const create = (body: unknown) =>
    app.inject({ method: "POST", url: avery, payload: body as object });
  const base = { name: "Check", instructions: "Check it." };
  for (const body of [
    { ...base, schedule: { type: "rrule", rule: "FREQ=DAILY" } },
    { ...base, schedule: { type: "interval", seconds: 900, jitter: 5 } },
    { ...base, schedule: { type: "interval", seconds: "900" } },
    { ...base, schedule: { type: "interval", seconds: 60 } },
    { ...base, schedule: { type: "once", at: "tomorrow" } },
    { ...base, schedule: { type: "cron", expression: "0 9 * * *" } },
    { ...base, schedule: weekdays, owner: "someone" },
    { ...base, name: "   ", schedule: weekdays },
    { ...base, name: "x".repeat(jobLimits.nameLength + 1), schedule: weekdays },
    { name: "Check", schedule: weekdays },
  ]) {
    const response = await create(body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.json().code, "INVALID_REQUEST");
  }
  for (const [schedule, message] of [
    [{ ...weekdays, timezone: "Mars/Olympus" }, /IANA/],
    [{ ...weekdays, expression: "*/1 * * * *" }, /five minutes apart/],
    [{ ...weekdays, expression: "0 9 * * MON" }, /five numeric fields/],
    [{ type: "once", at: "2026-11-05T09:00:00Z" }, /future/],
  ] as const) {
    const response = await create({ ...base, schedule });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "JOB_SCHEDULE_INVALID");
    assert.match(response.json().message, message);
  }
  const empty = await app.inject({
    method: "PATCH",
    url: `${avery}/${randomUUID()}`,
    payload: {},
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(store.jobs.size, 0);
});

test("previews, the per-teammate limit, and a finished one-time job's resume refusal", async (context) => {
  const { app, clock } = await fixture();
  context.after(() => app.close());
  const preview = await app.inject({
    method: "POST",
    url: `${avery}/preview`,
    payload: { schedule: weekdays },
  });
  assert.deepEqual(preview.json(), {
    nextRuns: [
      "2026-11-06T08:00:00.000Z",
      "2026-11-09T08:00:00.000Z",
      "2026-11-10T08:00:00.000Z",
    ],
  });
  const once = (
    await app.inject({
      method: "POST",
      url: avery,
      payload: {
        name: "Once",
        instructions: "Once.",
        schedule: { type: "once", at: "2026-11-05T10:30:00Z" },
        enabled: false,
      },
    })
  ).json();
  clock.advance(60 * 60_000);
  const late = await app.inject({
    method: "PATCH",
    url: `${avery}/${once.id}`,
    payload: { enabled: true },
  });
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().code, "JOB_SCHEDULE_PASSED");
  for (let index = 1; index < jobLimits.jobsPerTeammate; index++)
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: avery,
          payload: {
            name: `Job ${index}`,
            instructions: "Check.",
            schedule: { type: "interval", seconds: 3600 },
          },
        })
      ).statusCode,
      201,
    );
  const over = await app.inject({
    method: "POST",
    url: avery,
    payload: { name: "One more", instructions: "Check.", schedule: weekdays },
  });
  assert.equal(over.statusCode, 409);
  assert.equal(over.json().code, "JOB_LIMIT");
});

test("run now returns a pending run, refuses overlap, and stop cancels it; history shows only operations", async (context) => {
  const { app, wakeups, runs } = await fixture();
  context.after(() => app.close());
  const job = (
    await app.inject({
      method: "POST",
      url: avery,
      payload: { name: "Check", instructions: "Check it.", schedule: weekdays },
    })
  ).json();
  const started = await app.inject({
    method: "POST",
    url: `${avery}/${job.id}/runs`,
  });
  assert.equal(started.statusCode, 202);
  assert.equal(started.json().status, "pending");
  await settle();
  const again = await app.inject({
    method: "POST",
    url: `${avery}/${job.id}/runs`,
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, "JOB_RUN_ACTIVE");
  const listed = (await app.inject({ method: "GET", url: avery })).json();
  assert.equal(listed.jobs[0].latestRun.status, "running");

  const stopped = await app.inject({
    method: "POST",
    url: `${avery}/${job.id}/stop`,
  });
  assert.equal(stopped.statusCode, 204);
  await runs.settled();
  assert.deepEqual(wakeups.deleted, [wakeups.last.id]);
  const history = (
    await app.inject({ method: "GET", url: `${avery}/${job.id}/runs` })
  ).json();
  assert.equal(history.runs.length, 1);
  assert.deepEqual(Object.keys(history.runs[0]).sort(), [
    "error",
    "finishedAt",
    "id",
    "jobId",
    "scheduledFor",
    "startedAt",
    "status",
  ]);
  assert.equal(history.runs[0].status, "cancelled");
  assert.equal(history.runs[0].error, jobRunErrors.stoppedFromJob);
});
