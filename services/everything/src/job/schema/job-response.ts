import { Type } from "typebox";

/** A timestamp or nothing. */
const optionalTimestamp = Type.Union([
  Type.String({ format: "date-time" }),
  Type.Null(),
]);

/** A saved schedule in canonical form: UTC instants and canonical timezone names. */
const scheduleResponse = Type.Union([
  Type.Object({
    type: Type.Literal("once"),
    at: Type.String({ format: "date-time" }),
  }),
  Type.Object({ type: Type.Literal("interval"), seconds: Type.Integer() }),
  Type.Object({
    type: Type.Literal("cron"),
    expression: Type.String(),
    timezone: Type.String(),
  }),
]);

/** One run's operational lifecycle; it never includes what the teammate found or said. */
export const jobRunResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  jobId: Type.String({ format: "uuid" }),
  scheduledFor: Type.String({
    format: "date-time",
    description:
      "The occurrence this run handles: its due time, or when Run now was used.",
  }),
  status: Type.Union(
    ["pending", "running", "completed", "failed", "cancelled"].map((status) =>
      Type.Literal(status),
    ),
    {
      description:
        "pending until the teammate accepts the run, running until its temporary background session is removed, then completed, failed, or cancelled. completed means the session's last turn ended normally, whatever it found.",
    },
  ),
  startedAt: optionalTimestamp,
  finishedAt: optionalTimestamp,
  error: Type.Union([Type.String(), Type.Null()], {
    description: "A short, safe reason for a failed or cancelled run.",
  }),
});

/** A job and its most recent run. */
export const jobResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  agentId: Type.String({ format: "uuid" }),
  name: Type.String(),
  instructions: Type.String(),
  schedule: scheduleResponse,
  nextRunAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()], {
    description: "The next due time in UTC; null while the job is paused.",
  }),
  enabled: Type.Boolean(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
  latestRun: Type.Union([jobRunResponse, Type.Null()]),
});

/** A teammate's jobs, oldest first. */
export const jobListResponse = Type.Object({ jobs: Type.Array(jobResponse) });

/** A job's most recent runs, newest first. */
export const jobRunListResponse = Type.Object({
  runs: Type.Array(jobRunResponse),
});

/** The next times a schedule would run if saved now. */
export const jobPreviewResponse = Type.Object({
  nextRuns: Type.Array(Type.String({ format: "date-time" })),
});
