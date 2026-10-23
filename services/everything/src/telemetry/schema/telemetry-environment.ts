import { Type, type Static } from "typebox";
import { telemetryLimits } from "@everything/telemetry-contracts";

/** Lowercase identifiers OpenObserve accepts for organizations and streams. */
const identifier = Type.String({ pattern: "^[a-z0-9_]{1,64}$" });

/**
 * Telemetry deployment settings. The password is read from a file rather than the environment, so
 * processes Everything starts, such as fleetd, never inherit it.
 */
export const telemetryEnvironmentSchema = Type.Object({
  /** Base URL of the OpenObserve service inside the cluster; empty turns telemetry off. */
  TELEMETRY_URL: Type.String({
    pattern: "^(https?://[^/?#@\\s]+)?$",
    default: "",
  }),
  TELEMETRY_ORGANIZATION: { ...identifier, default: "default" },
  TELEMETRY_STREAM: { ...identifier, default: "everything" },
  /** OpenObserve's root account, which only Everything uses. */
  TELEMETRY_USERNAME: Type.String({
    pattern: "^[^\\s:@]{1,64}@[^\\s:@]{1,128}$",
    default: "everything@telemetry.local",
  }),
  TELEMETRY_PASSWORD_FILE: Type.String({
    pattern: "^/",
    default: "/var/run/secrets/telemetry/password",
  }),
  /** Days OpenObserve keeps records; the chart sets both services from the same value. */
  TELEMETRY_RETENTION_DAYS: Type.Integer({
    minimum: telemetryLimits.minRetentionDays,
    maximum: telemetryLimits.maxRetentionDays,
    default: 7,
  }),
  /** Share of successful, quick read requests whose traces are kept. */
  TELEMETRY_READ_SAMPLE_RATIO: Type.Number({
    minimum: 0,
    maximum: 1,
    default: 0.05,
  }),
  /** Deadline for one export or query request to OpenObserve. */
  TELEMETRY_TIMEOUT_MS: Type.Integer({
    minimum: 1_000,
    maximum: 60_000,
    default: 10_000,
  }),
  /**
   * Record the redacted text of provider and error messages, which can quote prompts and other
   * private text. Off by default; structured diagnostics are recorded either way.
   */
  TELEMETRY_INCLUDE_ERROR_TEXT: Type.Boolean({ default: false }),
  TELEMETRY_SERVICE_VERSION: Type.String({
    pattern: "^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$",
    default: "development",
  }),
});

/** Telemetry settings after env-schema validation and defaults. */
export type TelemetryEnvironment = Static<typeof telemetryEnvironmentSchema>;
