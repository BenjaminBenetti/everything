import assert from "node:assert/strict";
import { test } from "node:test";
import { loadApplicationConfig } from "../config/application-config.js";
/** Provide a minimal non-secret deployment fixture independent of process.env. */
function environment(): NodeJS.ProcessEnv {
  return {
    OIDC_ISSUER: "https://identity.test",
    OIDC_JWKS_URL: "https://identity.test/keys",
    OIDC_AUDIENCE: "api",
    PUBLIC_ORIGIN: "https://app.test",
    OIDC_PROTOCOL_URL: "http://identity.test/protocol/openid-connect",
    OIDC_CLIENT_ID: "web",
    OIDC_CLIENT_SECRET: "test-only",
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    DATABASE_URL: "postgresql://app@db/app",
    DATABASE_PASSWORD: "test-only",
    PI_STATE_DIRECTORY: "/state",
    AGENTS_DIRECTORY: "/workspace",
    WORKSPACE_NAMESPACE: "everything",
    WORKSPACE_TEMPLATE_NAME: "teammate",
    WORKSPACE_CLAIM_NAME: "everything-agents",
    ARTIFACT_SERVICE_URL: "http://artifact:8081",
    ARTIFACT_HOST_URL: "http://artifact.everything.svc.cluster.local:8080",
    ARTIFACT_CLIENT_ID: "artifact-client",
    ARTIFACT_CLIENT_SECRET: "test-only",
    FLEET_HOME: "/fleet",
    FLEET_VERSION: "v3.0.0-beta",
    FLEET_RELEASE_URL: "https://releases.test/fleet",
    FLEET_CHECKSUMS: JSON.stringify({ "fleet-linux-amd64": "a".repeat(64) }),
    FLEET_NAMESPACE: "everything-fleet",
    FLEET_REGISTRY: "registry.everything.test",
    REGISTRY_USERNAME: "everything",
    REGISTRY_PASSWORD: "test-only",
  };
}
test("env-schema applies port defaults/coercion without changing the supplied environment", () => {
  const source = environment();
  assert.equal(loadApplicationConfig(source).port, 8080);
  assert.equal(loadApplicationConfig({ ...source, PORT: "9443" }).port, 9443);
  assert.equal(source.PORT, undefined);
});
test("reads Fleet's pinned release, an empty storage class, and a verified registry", () => {
  const { fleet } = loadApplicationConfig({
    ...environment(),
    FLEET_STORAGE_CLASS: "",
  });
  assert.deepEqual(fleet.release, {
    version: "v3.0.0-beta",
    url: "https://releases.test/fleet",
    checksums: { "fleet-linux-amd64": "a".repeat(64) },
  });
  assert.equal(fleet.storageClass, "");
  assert.equal(fleet.registry.host, "registry.everything.test");
  assert.equal(fleet.registry.insecure, false);
});
test("reads a development registry whose certificate Fleet accepts unverified", () => {
  const { fleet } = loadApplicationConfig({
    ...environment(),
    FLEET_REGISTRY: "registry.test:5443",
    FLEET_REGISTRY_INSECURE: "true",
  });
  assert.equal(fleet.registry.host, "registry.test:5443");
  assert.equal(fleet.registry.insecure, true);
});
test("voice input is off by default with bounded transcription limits", () => {
  assert.deepEqual(loadApplicationConfig(environment()).voice, {
    service: null,
    stream: null,
    admission: { concurrency: 1, queueLimit: 4, queueTimeoutMs: 60_000 },
  });
});

test("reads a self-hosted speech recognition service and its limits", () => {
  const { voice } = loadApplicationConfig({
    ...environment(),
    VOICE_ASR_URL:
      "http://speech.everything.svc.cluster.local:8000/v1/audio/transcriptions",
    VOICE_ASR_TOKEN: "test-only",
    VOICE_ASR_MODEL: "speech-model-q8",
    VOICE_ASR_TIMEOUT_MS: "600000",
    VOICE_CONCURRENCY: "2",
    VOICE_QUEUE_LIMIT: "0",
    VOICE_QUEUE_TIMEOUT_MS: "1000",
  });
  assert.deepEqual(voice, {
    service: {
      url: "http://speech.everything.svc.cluster.local:8000/v1/audio/transcriptions",
      token: "test-only",
      model: "speech-model-q8",
      timeoutMs: 600_000,
    },
    stream: null,
    admission: { concurrency: 2, queueLimit: 0, queueTimeoutMs: 1_000 },
  });
});

test("reads a self-hosted streaming speech service with its token and limits", () => {
  const { voice } = loadApplicationConfig({
    ...environment(),
    VOICE_STREAM_URL:
      "ws://voice-asr.everything.svc.cluster.local:8080/v1/stream",
    VOICE_STREAM_TOKEN: "test-only",
    VOICE_STREAM_FINAL_TIMEOUT_MS: "45000",
    VOICE_STREAM_CONCURRENCY: "2",
  });
  assert.deepEqual(voice.stream, {
    url: "ws://voice-asr.everything.svc.cluster.local:8080/v1/stream",
    token: "test-only",
    finalTimeoutMs: 45_000,
    concurrency: 2,
  });
  assert.equal(
    loadApplicationConfig({
      ...environment(),
      VOICE_STREAM_URL: "wss://speech.test/v1/stream",
    }).voice.stream?.finalTimeoutMs,
    30_000,
  );
});

test("rejects streaming URLs that aren't WebSocket URLs or carry credentials or fragments", () => {
  for (const url of [
    "http://voice-asr:8080/v1/stream",
    "voice-asr:8080/v1/stream",
    "ws://user:secret-password@voice-asr/v1/stream",
    "ws://voice-asr/v1/stream#fragment",
  ])
    assert.throws(
      () => loadApplicationConfig({ ...environment(), VOICE_STREAM_URL: url }),
      (error: Error) => !error.message.includes("secret-password"),
      url,
    );
  for (const override of [
    { VOICE_STREAM_TOKEN: "two words" },
    { VOICE_STREAM_FINAL_TIMEOUT_MS: "999" },
    { VOICE_STREAM_FINAL_TIMEOUT_MS: "300001" },
    { VOICE_STREAM_CONCURRENCY: "0" },
  ])
    assert.throws(() =>
      loadApplicationConfig({
        ...environment(),
        VOICE_STREAM_URL: "ws://voice-asr/v1/stream",
        ...override,
      }),
    );
});

test("rejects speech service URLs with credentials, fragments, or other schemes without repeating them", () => {
  for (const url of [
    "speech:8000/transcribe",
    "/v1/audio/transcriptions",
    "ftp://speech/transcribe",
    "file:///models/speech",
    "http://user:secret-password@speech/transcribe",
    "http://speech/transcribe#fragment",
    "http://speech/transcribe#",
    "http://speech/ transcribe",
  ])
    assert.throws(
      () => loadApplicationConfig({ ...environment(), VOICE_ASR_URL: url }),
      (error: Error) => !error.message.includes("secret-password"),
      url,
    );
});

test("rejects invalid deployment input", () => {
  for (const override of [
    { PORT: "65536" },
    { PORT: "3.5" },
    { DATABASE_PASSWORD: "" },
    { DATABASE_PASSWORD: undefined },
    { DATABASE_URL: "https://db/app" },
    { AGENTS_DIRECTORY: undefined },
    { AGENTS_DIRECTORY: "relative/agents" },
    { AGENTS_DIRECTORY: "/agents" },
    { ARTIFACT_SERVICE_URL: "http://artifact:8081/path" },
    { ARTIFACT_HOST_URL: undefined },
    { ARTIFACT_HOST_URL: "http://artifact:8080/" },
    { ARTIFACT_CLIENT_SECRET: undefined },
    { FLEET_VERSION: "3.0.0" },
    { FLEET_RELEASE_URL: "https://releases.test/fleet/" },
    { FLEET_CHECKSUMS: "not json" },
    { FLEET_CHECKSUMS: JSON.stringify({ "fleet-linux-amd64": "abc" }) },
    { FLEET_REGISTRY: "registry.test/path" },
    { FLEET_REGISTRY: "https://registry.test" },
    { FLEET_REGISTRY_INSECURE: "sometimes" },
    { REGISTRY_PASSWORD: undefined },
    { VOICE_ASR_TOKEN: "two words" },
    { VOICE_ASR_MODEL: "x".repeat(257) },
    { VOICE_ASR_TIMEOUT_MS: "999" },
    { VOICE_ASR_TIMEOUT_MS: "900001" },
    { VOICE_CONCURRENCY: "0" },
    { VOICE_QUEUE_LIMIT: "-1" },
    { VOICE_QUEUE_TIMEOUT_MS: "soon" },
  ])
    assert.throws(() =>
      loadApplicationConfig({ ...environment(), ...override }),
    );
});
