import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadTelemetrySettings,
  loadTelemetrySettingsOrUnavailable,
} from "../config/telemetry-config.js";

/** A password file reader that returns `contents`, or throws when it is undefined. */
function secret(contents: string | undefined) {
  return (path: string) => {
    assert.equal(path, "/var/run/secrets/telemetry/password");
    if (contents === undefined) throw new Error("ENOENT");
    return contents;
  };
}

test("without a URL telemetry is off", () => {
  assert.deepEqual(loadTelemetrySettings({}, secret(undefined)), {
    enabled: false,
    backend: null,
    retentionDays: 7,
    readSampleRatio: 0.05,
    serviceVersion: "development",
    includeErrorText: true,
    includeContent: true,
  });
});

test("the backend is configured from the environment and its password file", () => {
  const settings = loadTelemetrySettings(
    {
      TELEMETRY_URL: "http://openobserve.everything.svc.cluster.local:5080",
      TELEMETRY_RETENTION_DAYS: "7",
      TELEMETRY_READ_SAMPLE_RATIO: "0.1",
      TELEMETRY_SERVICE_VERSION: "1.2.3",
      TELEMETRY_INCLUDE_ERROR_TEXT: "true",
    },
    secret("Ot1-derived\n"),
  );
  assert.deepEqual(settings, {
    enabled: true,
    retentionDays: 7,
    readSampleRatio: 0.1,
    serviceVersion: "1.2.3",
    includeErrorText: true,
    includeContent: true,
    backend: {
      url: "http://openobserve.everything.svc.cluster.local:5080",
      organization: "default",
      stream: "everything",
      username: "everything@telemetry.local",
      password: "Ot1-derived",
      timeoutMs: 10_000,
    },
  });
});

test("unreadable or empty credentials leave telemetry on but unavailable", () => {
  for (const contents of [undefined, "", "\n"]) {
    const settings = loadTelemetrySettings(
      { TELEMETRY_URL: "http://openobserve:5080" },
      secret(contents),
    );
    assert.equal(settings.enabled, true);
    assert.equal(settings.backend, null);
  }
});

test("retention is bounded and malformed settings never stop Everything from starting", () => {
  for (const environment of [
    { TELEMETRY_URL: "http://openobserve:5080", TELEMETRY_RETENTION_DAYS: "2" },
    {
      TELEMETRY_URL: "http://openobserve:5080",
      TELEMETRY_RETENTION_DAYS: "31",
    },
    { TELEMETRY_URL: "http://user:password@openobserve:5080" },
    { TELEMETRY_URL: "http://openobserve:5080/?token=x" },
    { TELEMETRY_URL: "http://openobserve:5080", TELEMETRY_STREAM: "Bad Name" },
    {
      TELEMETRY_URL: "http://openobserve:5080",
      TELEMETRY_INCLUDE_ERROR_TEXT: "maybe",
    },
    {
      TELEMETRY_URL: "http://openobserve:5080",
      TELEMETRY_INCLUDE_CONTENT: "maybe",
    },
  ]) {
    assert.throws(() => loadTelemetrySettings(environment, secret("x")));
    const settings = loadTelemetrySettingsOrUnavailable(
      environment,
      secret("x"),
    );
    assert.equal(settings.enabled, true);
    assert.equal(settings.backend, null);
    assert.equal(
      settings.includeErrorText,
      false,
      "unreadable settings record no error text",
    );
    assert.equal(
      settings.includeContent,
      false,
      "unreadable settings record no content",
    );
  }
});

test("error text is recorded by default and withheld only when the setting is false", () => {
  for (const [value, expected] of [
    [undefined, true],
    ["true", true],
    ["false", false],
  ] as const) {
    const settings = loadTelemetrySettings(
      {
        TELEMETRY_URL: "http://openobserve:5080",
        ...(value !== undefined ? { TELEMETRY_INCLUDE_ERROR_TEXT: value } : {}),
      },
      secret("x"),
    );
    assert.equal(settings.includeErrorText, expected, String(value));
  }
});

test("content follows error text unless set on its own, so an installation that withheld error text keeps content withheld", () => {
  for (const [errorText, content, expected] of [
    [undefined, undefined, true],
    ["false", undefined, false],
    ["true", undefined, true],
    ["false", "true", true],
    ["true", "false", false],
    [undefined, "false", false],
  ] as const) {
    const settings = loadTelemetrySettings(
      {
        TELEMETRY_URL: "http://openobserve:5080",
        ...(errorText !== undefined
          ? { TELEMETRY_INCLUDE_ERROR_TEXT: errorText }
          : {}),
        ...(content !== undefined
          ? { TELEMETRY_INCLUDE_CONTENT: content }
          : {}),
      },
      secret("x"),
    );
    assert.equal(
      settings.includeContent,
      expected,
      `error text ${errorText}, content ${content}`,
    );
  }
});
