import assert from "node:assert/strict";
import { test } from "node:test";
import { JobScheduleError } from "../error/job-errors.js";
import type { JobSchedule } from "../model/job.js";
import {
  advanceAfterClaim,
  describeSchedule,
  firstRunAt,
  nextRunAfter,
  normalizeSchedule,
  upcomingRuns,
} from "../model/job-schedule.js";

const now = new Date("2026-11-05T10:00:00.000Z");

/** ISO strings for compact comparisons. */
function iso(dates: readonly (Date | undefined)[]): (string | undefined)[] {
  return dates.map((date) => date?.toISOString());
}

/** Assert a schedule is refused with a message containing `fragment`. */
function refuses(schedule: unknown, fragment: RegExp): void {
  assert.throws(
    () => normalizeSchedule(schedule as JobSchedule, now),
    (error: unknown) =>
      error instanceof JobScheduleError &&
      error.status === 400 &&
      fragment.test(error.message),
  );
}

test("one-time schedules normalize offsets to UTC, must be ahead, and stop after their run", () => {
  const schedule = normalizeSchedule(
    { type: "once", at: "2026-12-01T10:00:00+01:00" },
    now,
  );
  assert.deepEqual(schedule, { type: "once", at: "2026-12-01T09:00:00.000Z" });
  assert.equal(
    firstRunAt(schedule, now)?.toISOString(),
    "2026-12-01T09:00:00.000Z",
  );
  assert.equal(
    firstRunAt(schedule, new Date("2026-12-02T00:00:00Z")),
    undefined,
  );
  assert.equal(nextRunAfter(schedule, new Date(schedule.at), now), undefined);
  // The run's time is kept for reference; disabling is what stops it being due.
  assert.deepEqual(
    advanceAfterClaim(
      { schedule, nextRunAt: "2026-12-01T09:00:00.000Z" },
      new Date("2026-12-01T09:00:05Z"),
    ),
    { nextRunAt: "2026-12-01T09:00:00.000Z", enabled: false },
  );
  refuses({ type: "once", at: "2026-11-05T09:59:59Z" }, /future/);
  refuses({ type: "once", at: "2026-11-05T10:00:00Z" }, /future/);
  refuses({ type: "once", at: "2026-12-01T09:00:00" }, /UTC offset/);
  refuses({ type: "once", at: "not a date" }, /UTC offset/);
  refuses({ type: "once", at: "2031-12-01T09:00:00Z" }, /five years/);
});

test("intervals start one interval after saving and stay on their grid, skipping missed ticks", () => {
  const schedule = normalizeSchedule({ type: "interval", seconds: 900 }, now);
  const first = firstRunAt(schedule, now)!;
  assert.equal(first.toISOString(), "2026-11-05T10:15:00.000Z");
  // Dispatching late doesn't drift the grid.
  assert.equal(
    nextRunAfter(
      schedule,
      first,
      new Date("2026-11-05T10:15:07Z"),
    )?.toISOString(),
    "2026-11-05T10:30:00.000Z",
  );
  // After three hours of downtime there is one catch-up run, then the next future grid point.
  assert.equal(
    nextRunAfter(
      schedule,
      first,
      new Date("2026-11-05T13:20:00Z"),
    )?.toISOString(),
    "2026-11-05T13:30:00.000Z",
  );
  // Exactly on a grid point moves to the following one, never the current instant again.
  assert.equal(
    nextRunAfter(
      schedule,
      first,
      new Date("2026-11-05T10:30:00Z"),
    )?.toISOString(),
    "2026-11-05T10:45:00.000Z",
  );
  assert.deepEqual(iso(upcomingRuns(schedule, now, 3)), [
    "2026-11-05T10:15:00.000Z",
    "2026-11-05T10:30:00.000Z",
    "2026-11-05T10:45:00.000Z",
  ]);
  refuses({ type: "interval", seconds: 299 }, /five minutes/);
  refuses({ type: "interval", seconds: 31_536_001 }, /365 days/);
  refuses({ type: "interval", seconds: 900.5 }, /five minutes/);
  refuses({ type: "interval", seconds: Number.NaN }, /five minutes/);
  refuses({ type: "interval", seconds: Infinity }, /five minutes/);
});

test("cron follows the IANA timezone across daylight saving changes", () => {
  const paris = normalizeSchedule(
    { type: "cron", expression: " 0  9 * * 1-5 ", timezone: "Europe/Paris" },
    new Date("2026-03-26T12:00:00Z"),
  );
  assert.deepEqual(paris, {
    type: "cron",
    expression: "0 9 * * 1-5",
    timezone: "Europe/Paris",
  });
  // Paris moves to summer time on Sunday 29 March 2026: 09:00 is 08:00Z before and 07:00Z after.
  assert.deepEqual(
    iso(upcomingRuns(paris, new Date("2026-03-26T12:00:00Z"), 3)),
    [
      "2026-03-27T08:00:00.000Z",
      "2026-03-30T07:00:00.000Z",
      "2026-03-31T07:00:00.000Z",
    ],
  );
  const newYork = { type: "cron", timezone: "America/New_York" } as const;
  // 02:30 doesn't exist on 8 March 2026 in New York; that day's run moves to 03:30 local.
  assert.deepEqual(
    iso(
      upcomingRuns(
        { ...newYork, expression: "30 2 * * *" },
        new Date("2026-03-07T12:00:00Z"),
        2,
      ),
    ),
    ["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"],
  );
  // 01:30 happens twice on 1 November 2026; it runs once.
  assert.deepEqual(
    iso(
      upcomingRuns(
        { ...newYork, expression: "30 1 * * *" },
        new Date("2026-10-31T12:00:00Z"),
        2,
      ),
    ),
    ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"],
  );
  // Missed matches are skipped: the next run after downtime is the first match after now.
  assert.equal(
    nextRunAfter(
      paris,
      new Date("2026-03-27T08:00:00Z"),
      new Date("2026-04-02T12:00:00Z"),
    )?.toISOString(),
    "2026-04-03T07:00:00.000Z",
  );
  // Day of month and day of week combine with OR, as standard cron does.
  assert.deepEqual(
    iso(
      upcomingRuns(
        { type: "cron", expression: "0 9 1 * 1", timezone: "UTC" },
        new Date("2026-11-25T00:00:00Z"),
        3,
      ),
    ),
    [
      "2026-11-30T09:00:00.000Z",
      "2026-12-01T09:00:00.000Z",
      "2026-12-07T09:00:00.000Z",
    ],
  );
});

test("cron rejects unsupported syntax, impossible dates, tight spacing, and non-IANA zones", () => {
  const cron = (expression: string, timezone = "UTC") => ({
    type: "cron" as const,
    expression,
    timezone,
  });
  refuses(cron("0 9 * *"), /five numeric fields/);
  refuses(cron("0 0 9 * * *"), /five numeric fields/);
  refuses(cron("0 9 L * *"), /five numeric fields/);
  refuses(cron("0 9 * * MON"), /five numeric fields/);
  refuses(cron("0 9 ? * 1"), /five numeric fields/);
  refuses(cron("61 9 * * *"), /within its range/);
  refuses(cron("0 9 30 2 *"), /never matches/);
  refuses(cron("* * * * *"), /five minutes apart/);
  refuses(cron("0,4 9 * * *"), /five minutes apart/);
  refuses(cron(`${"1,".repeat(50)}2 9 * * *`), /five numeric fields/);
  assert.deepEqual(
    normalizeSchedule(cron("*/5 * * * *"), now),
    cron("*/5 * * * *"),
  );
  refuses(cron("0 9 * * *", "Mars/Olympus"), /IANA/);
  refuses(cron("0 9 * * *", "+05:00"), /IANA/);
  refuses(cron("0 9 * * *", ""), /IANA/);
  refuses(cron("0 9 * * *", `Europe/${"X".repeat(70)}`), /IANA/);
  assert.equal(
    (normalizeSchedule(cron("0 9 * * *", "utc"), now) as { timezone: string })
      .timezone,
    "UTC",
  );
});

test("schedules describe themselves plainly for the teammate", () => {
  assert.equal(
    describeSchedule({ type: "interval", seconds: 900 }),
    "every 15 minutes",
  );
  assert.equal(
    describeSchedule({ type: "interval", seconds: 3600 }),
    "every hour",
  );
  assert.equal(
    describeSchedule({ type: "interval", seconds: 172_800 }),
    "every 2 days",
  );
  assert.equal(
    describeSchedule({ type: "interval", seconds: 301 }),
    "every 301 seconds",
  );
  assert.equal(
    describeSchedule({
      type: "cron",
      expression: "0 9 * * 1-5",
      timezone: "Europe/Paris",
    }),
    'on cron "0 9 * * 1-5" in Europe/Paris',
  );
});
