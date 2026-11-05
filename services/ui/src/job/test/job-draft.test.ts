import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentJob } from "@everything/agent-contracts/job";
import {
  describeSchedule,
  draftFromJob,
  emptyDraft,
  jobChanges,
  jobStatus,
  scheduleFromDraft,
  timezoneOptions,
} from "../model/job-draft.js";

const now = new Date("2026-11-05T10:00:00.000Z");

/** A saved job with overrides. */
function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "job",
    agentId: "agent",
    name: "Morning PRs",
    instructions: "List PRs.",
    schedule: {
      type: "cron",
      expression: "0 9 * * 1-5",
      timezone: "Europe/Paris",
    },
    nextRunAt: "2026-11-06T08:00:00.000Z",
    enabled: true,
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    latestRun: null,
    ...overrides,
  };
}

test("drafts turn into schedules, catching what the form can check before the server does", () => {
  const draft = emptyDraft(now, "Europe/Paris");
  assert.deepEqual(scheduleFromDraft(draft), {
    schedule: { type: "interval", seconds: 3600 },
  });
  assert.deepEqual(
    scheduleFromDraft({
      ...draft,
      intervalAmount: "15",
      intervalUnit: "minutes",
    }),
    { schedule: { type: "interval", seconds: 900 } },
  );
  assert.deepEqual(
    scheduleFromDraft({
      ...draft,
      intervalAmount: "4",
      intervalUnit: "minutes",
    }),
    { error: "Choose at least five minutes." },
  );
  assert.deepEqual(
    scheduleFromDraft({
      ...draft,
      intervalAmount: "366",
      intervalUnit: "days",
    }),
    { error: "Choose at most 365 days." },
  );
  assert.deepEqual(scheduleFromDraft({ ...draft, intervalAmount: "1.5" }), {
    error: "Enter a whole number.",
  });
  assert.deepEqual(
    scheduleFromDraft({
      ...draft,
      kind: "cron",
      cronExpression: " 0 9 * * 1-5 ",
    }),
    {
      schedule: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Europe/Paris",
      },
    },
  );
  assert.deepEqual(
    scheduleFromDraft({ ...draft, kind: "cron", cronExpression: " " }),
    {
      error: "Enter a cron expression.",
    },
  );
  assert.deepEqual(
    scheduleFromDraft({
      ...draft,
      kind: "cron",
      cronExpression: "0 9 * * MON",
    }),
    {
      error:
        "Enter five numeric fields: minute, hour, day of month, month, and day of week.",
    },
  );
  assert.deepEqual(scheduleFromDraft({ ...draft, kind: "once", onceAt: "" }), {
    error: "Choose a date and time.",
  });
  assert.deepEqual(
    scheduleFromDraft(
      { ...draft, kind: "once", onceAt: "2026-11-01T09:30" },
      now,
    ),
    { error: "Choose a time in the future." },
  );
  const once = scheduleFromDraft(
    { ...draft, kind: "once", onceAt: "2026-12-01T09:30" },
    now,
  );
  assert.ok("schedule" in once && once.schedule.type === "once");
  // The local time is sent as a UTC instant.
  assert.equal(once.schedule.at, new Date(2026, 11, 1, 9, 30).toISOString());
});

test("saved jobs fill the form, and edits send only what changed", () => {
  const cron = job();
  const draft = draftFromJob(cron, now, "UTC");
  assert.equal(draft.kind, "cron");
  assert.equal(draft.cronExpression, "0 9 * * 1-5");
  assert.equal(draft.timezone, "Europe/Paris");
  assert.deepEqual(
    jobChanges(cron, " Morning PRs ", "List PRs.", cron.schedule),
    {},
  );
  assert.deepEqual(
    jobChanges(cron, "PRs", "List PRs.", { type: "interval", seconds: 900 }),
    { name: "PRs", schedule: { type: "interval", seconds: 900 } },
  );
  const interval = draftFromJob(
    job({ schedule: { type: "interval", seconds: 7200 } }),
    now,
    "UTC",
  );
  assert.deepEqual(
    [interval.intervalAmount, interval.intervalUnit],
    ["2", "hours"],
  );
  const once = job({
    schedule: { type: "once", at: "2026-12-01T09:30:00.000Z" },
  });
  const onceDraft = draftFromJob(once, now, "UTC");
  const resubmitted = scheduleFromDraft(onceDraft);
  assert.ok("schedule" in resubmitted);
  // The same instant isn't a change, so saving a renamed one-time job doesn't reschedule it.
  assert.deepEqual(
    jobChanges(once, "Renamed", once.instructions, resubmitted.schedule),
    {
      name: "Renamed",
    },
  );
});

test("schedules and job states read plainly", () => {
  assert.equal(
    describeSchedule({ type: "interval", seconds: 900 }),
    "Every 15 minutes",
  );
  assert.equal(
    describeSchedule({ type: "interval", seconds: 3600 }),
    "Every hour",
  );
  assert.equal(
    describeSchedule({ type: "interval", seconds: 86_400 * 2 }),
    "Every 2 days",
  );
  assert.equal(
    describeSchedule({ type: "interval", seconds: 301 }),
    "Every 301 seconds",
  );
  assert.equal(
    describeSchedule(job().schedule),
    "Cron 0 9 * * 1-5 (Europe/Paris)",
  );
  assert.equal(
    describeSchedule(
      { type: "once", at: "2026-12-01T09:30:00.000Z" },
      "en-US",
      "UTC",
    ),
    "Once, Dec 1, 2026, 9:30 AM",
  );
  assert.deepEqual(jobStatus(job(), "en-US", "UTC"), {
    label: "Next Nov 6, 2026, 8:00 AM",
    tone: "idle",
  });
  const run = {
    id: "run",
    jobId: "job",
    scheduledFor: "2026-11-05T09:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-11-05T09:00:01.000Z",
    error: "Didn't start.",
  };
  assert.deepEqual(
    jobStatus(
      job({
        latestRun: {
          ...run,
          status: "running",
          finishedAt: null,
          startedAt: run.scheduledFor,
        },
      }),
    ),
    { label: "Running now", tone: "active" },
  );
  assert.deepEqual(
    jobStatus(
      job({
        enabled: false,
        nextRunAt: null,
        latestRun: { ...run, status: "failed" },
      }),
    ),
    { label: "Paused · Last run failed", tone: "failed" },
  );
  assert.deepEqual(
    jobStatus(
      job({
        enabled: false,
        nextRunAt: null,
        schedule: { type: "once", at: run.scheduledFor },
        latestRun: { ...run, status: "completed", error: null },
      }),
    ),
    { label: "Done", tone: "paused" },
  );
  const zones = timezoneOptions("Europe/Paris");
  assert.equal(zones[0], "UTC");
  assert.equal(new Set(zones).size, zones.length);
  assert.ok(zones.includes("America/New_York"));
});
