import { Type, type Static } from "typebox";
import { workspaceLimits } from "./operations.js";

/** Bounds shared by the monitor tools, the teammate pod's internal API, and its process supervision. */
export const monitorLimits = {
  /** Commands may watch long jobs, but none outlives a day. */
  timeoutSeconds: 24 * 60 * 60,
  defaultTimeoutSeconds: 60 * 60,
  /** Output retained in memory: the beginning and the end, which usually holds the outcome. */
  headBytes: 8 * 1024,
  tailBytes: 16 * 1024,
  /** Each command's complete output log stops growing at this size. */
  logBytes: 8 * 1024 * 1024,
  /** Logs kept in the workspace; older logs of finished commands are removed. */
  retainedLogs: 20,
  /** Running monitors per teammate. */
  concurrent: 16,
  /** Longest single wait request; callers repeat it until the command finishes. */
  waitSeconds: 20,
} as const;

/** Workspace-relative folder holding each monitor's complete output log. */
export const monitorLogDirectory = ".monitors";

/** Start one background command in the same environment as the Bash tool. */
export const monitorInput = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      maxLength: workspaceLimits.commandLength,
    }),
    cwd: Type.Optional(
      Type.String({ minLength: 1, maxLength: workspaceLimits.pathLength }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({ minimum: 1, maximum: monitorLimits.timeoutSeconds }),
    ),
  },
  { additionalProperties: false },
);

/** Address one monitor by its pod-issued ID. */
export const monitorParams = Type.Object(
  { id: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

export type MonitorInput = Static<typeof monitorInput>;
export type MonitorParams = Static<typeof monitorParams>;

/** A running command, or how it ended: its own exit, the timeout, a stop request, or a failed start. */
export type MonitorStatus =
  "running" | "exited" | "timed-out" | "cancelled" | "failed";

/** A monitor's state with bounded output; `log` holds up to `logBytes` of the complete output. */
export interface MonitorResult {
  readonly id: string;
  readonly status: MonitorStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Combined stdout/stderr; when truncated, the beginning and end with an omission marker between. */
  readonly output: string;
  /** Total bytes the command wrote, including omitted output. */
  readonly outputBytes: number;
  readonly truncated: boolean;
  /** Workspace-relative path of the complete output log. */
  readonly log: string;
  readonly logTruncated: boolean;
  /** Why the command was cancelled or could not start. */
  readonly reason: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}
