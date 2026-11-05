import {
  jobLimits,
  type AgentJob,
  type JobRun,
  type JobSchedule,
  type UpdateJobInput,
} from "@everything/agent-contracts/job";

// ===========================================
// Drafts
// ===========================================

/** Units an interval can be entered in. */
export type IntervalUnit = "minutes" | "hours" | "days";

/** Seconds in each interval unit. */
const unitSeconds: Readonly<Record<IntervalUnit, number>> = {
  minutes: 60,
  hours: 3_600,
  days: 86_400,
};

/** The job form's fields; every schedule type keeps its own inputs while the user switches. */
export interface JobDraft {
  readonly name: string;
  readonly instructions: string;
  readonly kind: JobSchedule["type"];
  /** A one-time job's local date and time, as a `datetime-local` value in the browser's timezone. */
  readonly onceAt: string;
  readonly intervalAmount: string;
  readonly intervalUnit: IntervalUnit;
  readonly cronExpression: string;
  readonly timezone: string;
}

/** A new job: hourly, with a one-time default of tomorrow at 09:00 and cron in the browser's timezone. */
export function emptyDraft(now: Date, timezone: string): JobDraft {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return {
    name: "",
    instructions: "",
    kind: "interval",
    onceAt: localDateTimeValue(tomorrow.toISOString()),
    intervalAmount: "1",
    intervalUnit: "hours",
    cronExpression: "0 9 * * 1-5",
    timezone,
  };
}

/** Fill the form from a saved job, keeping defaults for the other schedule types. */
export function draftFromJob(
  job: AgentJob,
  now: Date,
  timezone: string,
): JobDraft {
  const draft = {
    ...emptyDraft(now, timezone),
    name: job.name,
    instructions: job.instructions,
    kind: job.schedule.type,
  };
  switch (job.schedule.type) {
    case "once":
      return { ...draft, onceAt: localDateTimeValue(job.schedule.at) };
    case "interval": {
      const unit = largestUnit(job.schedule.seconds);
      return {
        ...draft,
        intervalAmount: String(job.schedule.seconds / unitSeconds[unit]),
        intervalUnit: unit,
      };
    }
    case "cron":
      return {
        ...draft,
        cronExpression: job.schedule.expression,
        timezone: job.schedule.timezone,
      };
  }
}

/** Five whitespace-separated numeric cron fields, as the server accepts. */
const cronFields = /^[0-9*,/-]+(?:\s+[0-9*,/-]+){4}$/;

/**
 * The schedule a draft describes, or a plain reason it can't be one yet. The server checks the rest,
 * such as cron ranges and spacing, when it previews or saves.
 */
export function scheduleFromDraft(
  draft: JobDraft,
  now = new Date(),
): { schedule: JobSchedule } | { error: string } {
  switch (draft.kind) {
    case "once": {
      const at = new Date(draft.onceAt);
      if (!draft.onceAt || !Number.isFinite(at.getTime()))
        return { error: "Choose a date and time." };
      if (at.getTime() <= now.getTime())
        return { error: "Choose a time in the future." };
      return { schedule: { type: "once", at: at.toISOString() } };
    }
    case "interval": {
      const amount = Number(draft.intervalAmount);
      if (!/^\d+$/.test(draft.intervalAmount.trim()) || amount < 1)
        return { error: "Enter a whole number." };
      const seconds = amount * unitSeconds[draft.intervalUnit];
      if (seconds < jobLimits.minIntervalSeconds)
        return { error: "Choose at least five minutes." };
      if (seconds > jobLimits.maxIntervalSeconds)
        return { error: "Choose at most 365 days." };
      return { schedule: { type: "interval", seconds } };
    }
    case "cron":
      if (!draft.cronExpression.trim())
        return { error: "Enter a cron expression." };
      if (!cronFields.test(draft.cronExpression.trim()))
        return {
          error:
            "Enter five numeric fields: minute, hour, day of month, month, and day of week.",
        };
      if (!draft.timezone) return { error: "Choose a timezone." };
      return {
        schedule: {
          type: "cron",
          expression: draft.cronExpression.trim(),
          timezone: draft.timezone,
        },
      };
  }
}

/** Only the fields an edit changes, so an unchanged schedule never restarts the job's timing. */
export function jobChanges(
  job: AgentJob,
  name: string,
  instructions: string,
  schedule: JobSchedule,
): UpdateJobInput {
  return {
    ...(name.trim() === job.name ? {} : { name: name.trim() }),
    ...(instructions.trim() === job.instructions
      ? {}
      : { instructions: instructions.trim() }),
    ...(sameSchedule(schedule, job.schedule) ? {} : { schedule }),
  };
}

/** Whether two schedules mean the same times. */
function sameSchedule(a: JobSchedule, b: JobSchedule): boolean {
  if (a.type === "once" && b.type === "once")
    return Date.parse(a.at) === Date.parse(b.at);
  return JSON.stringify(a) === JSON.stringify(b);
}

// ===========================================
// Presentation
// ===========================================

/** A plain description of when a job runs. */
export function describeSchedule(
  schedule: JobSchedule,
  locale?: string,
  timeZone?: string,
): string {
  switch (schedule.type) {
    case "once":
      return `Once, ${formatDateTime(schedule.at, locale, timeZone)}`;
    case "interval": {
      // The API accepts any whole number of seconds; the form only offers minutes and up.
      if (schedule.seconds % 60) return `Every ${schedule.seconds} seconds`;
      const unit = largestUnit(schedule.seconds);
      const amount = schedule.seconds / unitSeconds[unit];
      return amount === 1
        ? `Every ${unit.slice(0, -1)}`
        : `Every ${amount} ${unit}`;
    }
    case "cron":
      return `Cron ${schedule.expression} (${schedule.timezone})`;
  }
}

/** One line about where a job stands: running, paused, done, or when it runs next. */
export function jobStatus(
  job: AgentJob,
  locale?: string,
  timeZone?: string,
): { label: string; tone: "active" | "idle" | "paused" | "failed" } {
  const run = job.latestRun;
  if (run && (run.status === "pending" || run.status === "running"))
    return { label: "Running now", tone: "active" };
  const failed = run?.status === "failed" ? " · Last run failed" : "";
  if (!job.enabled)
    return {
      label: (job.schedule.type === "once" && run ? "Done" : "Paused") + failed,
      tone: failed ? "failed" : "paused",
    };
  return {
    label: `Next ${formatDateTime(job.nextRunAt!, locale, timeZone)}${failed}`,
    tone: failed ? "failed" : "idle",
  };
}

/** How a run is shown. */
export const runStatusLabels: Readonly<Record<JobRun["status"], string>> = {
  pending: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A medium date and short time in the browser's locale and timezone unless given. */
export function formatDateTime(
  iso: string,
  locale?: string,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** IANA timezones for the picker, with UTC first. */
export function timezoneOptions(current: string): string[] {
  return [
    ...new Set(["UTC", current, ...Intl.supportedValuesOf("timeZone")]),
  ].filter(Boolean);
}

// ===========================================
// Helpers
// ===========================================

/** A `datetime-local` value for an instant in the browser's timezone. */
export function localDateTimeValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The largest unit that divides an interval exactly. */
function largestUnit(seconds: number): IntervalUnit {
  if (seconds % unitSeconds.days === 0) return "days";
  if (seconds % unitSeconds.hours === 0) return "hours";
  return "minutes";
}
