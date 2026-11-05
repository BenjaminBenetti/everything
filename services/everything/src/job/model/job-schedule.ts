import { Cron } from "croner";
import {
  jobLimits,
  type AgentJobDefinition,
  type JobAdvance,
  type JobSchedule,
} from "./job.js";
import { JobScheduleError } from "../error/job-errors.js";

// ===========================================
// Validation
// ===========================================

/** Digits, `*`, lists, ranges, and steps only: no names, seconds, `L`, `W`, `#`, or `?`. */
const cronField = /^[0-9*,/-]+$/;

/** IANA names such as `Europe/Paris`, `UTC`, or `Etc/GMT+5`; rejects raw offsets like `+05:00`. */
const timezoneName = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** A date-time with an explicit UTC offset or `Z`. */
const explicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/i;

/** Upcoming cron matches checked for spacing, enough to see every minute and hour list repeat. */
const cronSpacingSample = 24;

/**
 * Check a schedule against `now` and return its canonical form: UTC instants, single-spaced cron
 * fields, and the timezone's canonical name. One-time jobs must be in the future.
 */
export function normalizeSchedule(
  schedule: JobSchedule,
  now: Date,
): JobSchedule {
  switch (schedule.type) {
    case "once": {
      const at = new Date(schedule.at);
      if (!explicitOffset.test(schedule.at) || !Number.isFinite(at.getTime()))
        throw new JobScheduleError(
          "Enter the time as a date and time with a UTC offset, such as 2026-12-01T09:00:00Z.",
        );
      if (at.getTime() <= now.getTime())
        throw new JobScheduleError("Choose a time in the future.");
      if (at.getTime() - now.getTime() > jobLimits.maxOnceAheadMs)
        throw new JobScheduleError("Choose a time within the next five years.");
      return { type: "once", at: at.toISOString() };
    }
    case "interval": {
      const { seconds } = schedule;
      if (
        !Number.isInteger(seconds) ||
        seconds < jobLimits.minIntervalSeconds ||
        seconds > jobLimits.maxIntervalSeconds
      )
        throw new JobScheduleError(
          "Choose an interval between five minutes and 365 days.",
        );
      return { type: "interval", seconds };
    }
    case "cron": {
      const timezone = normalizeTimezone(schedule.timezone);
      const expression = schedule.expression.trim().split(/\s+/).join(" ");
      const fields = expression.split(" ");
      if (
        expression.length > jobLimits.cronLength ||
        fields.length !== 5 ||
        !fields.every((field) => cronField.test(field))
      )
        throw new JobScheduleError(
          "Enter a cron expression with five numeric fields: minute, hour, day of month, month, and day of week.",
        );
      const runs = cronRuns(expression, timezone, now, cronSpacingSample);
      if (!runs.length)
        throw new JobScheduleError(
          "This cron expression never matches a date.",
        );
      for (let index = 1; index < runs.length; index++)
        if (
          runs[index]!.getTime() - runs[index - 1]!.getTime() <
          jobLimits.minIntervalSeconds * 1000
        )
          throw new JobScheduleError(
            "Cron matches must be at least five minutes apart.",
          );
      return { type: "cron", expression, timezone };
    }
  }
}

/** Resolve an IANA timezone to its canonical name, or refuse it. */
function normalizeTimezone(timezone: string): string {
  if (
    timezone.length <= jobLimits.timezoneLength &&
    timezoneName.test(timezone)
  )
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
      }).resolvedOptions().timeZone;
    } catch {
      // Unknown names fall through to the shared error.
    }
  throw new JobScheduleError(
    "Choose a timezone from the IANA list, such as Europe/Paris or UTC.",
  );
}

// ===========================================
// Due times
// ===========================================

/**
 * When a job created, resumed, or rescheduled at `now` is first due: the one-time instant if it's
 * still ahead, one interval from now, or the next cron match. Undefined when a one-time job's time
 * has passed.
 */
export function firstRunAt(schedule: JobSchedule, now: Date): Date | undefined {
  switch (schedule.type) {
    case "once": {
      const at = new Date(schedule.at);
      return at.getTime() > now.getTime() ? at : undefined;
    }
    case "interval":
      return new Date(now.getTime() + schedule.seconds * 1000);
    case "cron":
      return cronRuns(schedule.expression, schedule.timezone, now, 1)[0];
  }
}

/**
 * The next due time after the occurrence due at `due` was claimed at `now`. Missed occurrences are
 * skipped, never replayed: intervals stay on the grid anchored at `due` and move to its first point
 * after `now`, and cron moves to its first match after `now`. Undefined after a one-time job's run
 * or a cron expression's last match.
 */
export function nextRunAfter(
  schedule: JobSchedule,
  due: Date,
  now: Date,
): Date | undefined {
  switch (schedule.type) {
    case "once":
      return undefined;
    case "interval": {
      const step = schedule.seconds * 1000;
      const elapsed = Math.max(0, now.getTime() - due.getTime());
      return new Date(due.getTime() + (Math.floor(elapsed / step) + 1) * step);
    }
    case "cron":
      return cronRuns(schedule.expression, schedule.timezone, now, 1)[0];
  }
}

/** The next `count` due times for a schedule saved at `now`, for previews. */
export function upcomingRuns(
  schedule: JobSchedule,
  now: Date,
  count: number,
): Date[] {
  const runs: Date[] = [];
  let next = firstRunAt(schedule, now);
  while (next && runs.length < count) {
    runs.push(next);
    next = nextRunAfter(schedule, next, next);
  }
  return runs;
}

/** Matches strictly after `after`, in the expression's timezone, following its DST rules. */
function cronRuns(
  expression: string,
  timezone: string,
  after: Date,
  count: number,
): Date[] {
  try {
    return new Cron(expression, {
      timezone,
      mode: "5-part",
      paused: true,
    }).nextRuns(count, after);
  } catch {
    throw new JobScheduleError(
      "Enter a valid cron expression; each field must be within its range, such as 0-59 for minutes.",
    );
  }
}

// ===========================================
// Descriptions
// ===========================================

/** Describe a schedule in plain words for the teammate's task text. */
export function describeSchedule(schedule: JobSchedule): string {
  switch (schedule.type) {
    case "once":
      return `once, at ${schedule.at}`;
    case "interval":
      return `every ${describeSeconds(schedule.seconds)}`;
    case "cron":
      return `on cron "${schedule.expression}" in ${schedule.timezone}`;
  }
}

/** Say an interval in its largest whole unit. */
function describeSeconds(seconds: number): string {
  for (const [unit, size] of [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const)
    if (seconds % size === 0) {
      const count = seconds / size;
      return count === 1 ? unit : `${count} ${unit}s`;
    }
  return `${seconds} seconds`;
}

// ===========================================
// Claims
// ===========================================

/** Where a claimed occurrence moves its job: the next due time, or disabled after its last run. */
export function advanceAfterClaim(
  job: Pick<AgentJobDefinition, "schedule" | "nextRunAt">,
  now: Date,
): JobAdvance {
  const next = nextRunAfter(job.schedule, new Date(job.nextRunAt), now);
  // A finished one-time job keeps its time for reference; it stops being due because it's disabled.
  return next
    ? { nextRunAt: next.toISOString(), enabled: true }
    : { nextRunAt: job.nextRunAt, enabled: false };
}
