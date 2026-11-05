import { Type, type Static } from "typebox";
import { nonBlankText } from "../../http/schema/text-schema.js";
import { jobLimits } from "../model/job.js";

/** A job UUID belongs to exactly one saved teammate. */
export const jobParams = Type.Object(
  {
    agentId: Type.String({ format: "uuid" }),
    jobId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
export type JobParams = Static<typeof jobParams>;

/** Run once at an instant that must include a UTC offset, such as `2026-12-01T09:00:00Z`. */
const onceSchedule = Type.Object(
  {
    type: Type.Literal("once"),
    at: Type.String({ format: "date-time", maxLength: 40 }),
  },
  { additionalProperties: false },
);

/** Run every `seconds`, from five minutes to 365 days. */
const intervalSchedule = Type.Object(
  {
    type: Type.Literal("interval"),
    seconds: Type.Integer({
      minimum: jobLimits.minIntervalSeconds,
      maximum: jobLimits.maxIntervalSeconds,
    }),
  },
  { additionalProperties: false },
);

/** Five numeric cron fields in an IANA timezone; matches must be at least five minutes apart. */
const cronSchedule = Type.Object(
  {
    type: Type.Literal("cron"),
    expression: nonBlankText(jobLimits.cronLength),
    timezone: nonBlankText(jobLimits.timezoneLength),
  },
  { additionalProperties: false },
);

/** Exactly one supported schedule type, with no other fields. */
export const jobSchedule = Type.Union(
  [onceSchedule, intervalSchedule, cronSchedule],
  {
    description:
      'One of {"type":"once","at":"2026-12-01T09:00:00Z"}, {"type":"interval","seconds":900}, or {"type":"cron","expression":"0 9 * * 1-5","timezone":"Europe/Paris"}.',
  },
);

/** A named job with the instructions its runs receive. */
export const createJobBody = Type.Object(
  {
    name: nonBlankText(jobLimits.nameLength),
    instructions: nonBlankText(jobLimits.instructionsLength),
    schedule: jobSchedule,
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreateJobBody = Static<typeof createJobBody>;

/** Change one or more fields; `enabled: false` pauses future runs without stopping a current one. */
export const updateJobBody = Type.Object(
  {
    name: Type.Optional(nonBlankText(jobLimits.nameLength)),
    instructions: Type.Optional(nonBlankText(jobLimits.instructionsLength)),
    schedule: Type.Optional(jobSchedule),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateJobBody = Static<typeof updateJobBody>;

/** Check a schedule and see its next times without saving it. */
export const jobPreviewBody = Type.Object(
  { schedule: jobSchedule },
  { additionalProperties: false },
);
export type JobPreviewBody = Static<typeof jobPreviewBody>;
