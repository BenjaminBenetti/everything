import { readFileSync } from "node:fs";
import envSchema from "env-schema";
import type { TelemetrySettings } from "../model/telemetry-settings.js";
import {
  telemetryEnvironmentSchema,
  type TelemetryEnvironment,
} from "../schema/telemetry-environment.js";

/** Read the backend password; missing or unreadable credentials leave telemetry unavailable. */
export type SecretReader = (path: string) => string;

/**
 * Validate telemetry settings with env-schema and read the backend's password from its file. A
 * malformed setting throws, like any other deployment setting; unreadable credentials do not stop
 * Everything, they leave telemetry unavailable.
 */
export function loadTelemetrySettings(
  environment: NodeJS.ProcessEnv,
  readSecret: SecretReader = (path) => readFileSync(path, "utf8"),
): TelemetrySettings {
  const settings = envSchema<TelemetryEnvironment>({
    schema: telemetryEnvironmentSchema,
    env: false,
    data: environment,
  });
  const common = {
    retentionDays: settings.TELEMETRY_RETENTION_DAYS,
    readSampleRatio: settings.TELEMETRY_READ_SAMPLE_RATIO,
    serviceVersion: settings.TELEMETRY_SERVICE_VERSION,
    includeErrorText: settings.TELEMETRY_INCLUDE_ERROR_TEXT,
  };
  if (!settings.TELEMETRY_URL)
    return { ...common, enabled: false, backend: null };
  const password = readPassword(settings.TELEMETRY_PASSWORD_FILE, readSecret);
  return {
    ...common,
    enabled: true,
    backend: password
      ? {
          url: settings.TELEMETRY_URL,
          organization: settings.TELEMETRY_ORGANIZATION,
          stream: settings.TELEMETRY_STREAM,
          username: settings.TELEMETRY_USERNAME,
          password,
          timeoutMs: settings.TELEMETRY_TIMEOUT_MS,
        }
      : null,
  };
}

/**
 * Telemetry settings that never stop Everything from starting: malformed settings leave telemetry
 * turned on but unavailable, so the Telemetry page explains it, with one line on standard error.
 */
export function loadTelemetrySettingsOrUnavailable(
  environment: NodeJS.ProcessEnv,
  readSecret?: SecretReader,
): TelemetrySettings {
  try {
    return loadTelemetrySettings(environment, readSecret);
  } catch {
    console.warn(
      "Telemetry settings are invalid; telemetry is unavailable until they are fixed.",
    );
    return {
      enabled: true,
      backend: null,
      retentionDays: 7,
      readSampleRatio: 0,
      serviceVersion: "unknown",
      includeErrorText: false,
    };
  }
}

/** The file's first line, or nothing when the file is missing, unreadable, or empty. */
function readPassword(path: string, readSecret: SecretReader): string {
  try {
    return readSecret(path).split(/\r?\n/, 1)[0]!.trim();
  } catch {
    return "";
  }
}
