import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import { ApiDocumentationService } from "../../api-documentation/service/api-documentation-service.js";
import {
  createHttpApplication,
  type HttpDependencies,
} from "../../application/factory/http-application.js";
import { FfmpegAudioDecoder } from "../adapter/ffmpeg-audio-decoder.js";
import { VoiceRecordingInvalidError } from "../error/voice-errors.js";
import { createVoiceRuntime } from "../factory/voice-runtime.js";
import type { VoiceSettings } from "../model/voice-settings.js";
import { ffmpegMissing, syntheticRecording } from "./synthetic-audio.js";
import { TelemetryQueryService } from "../../telemetry/service/telemetry-query-service.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const foreignAgentId = "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c";
const route = `/v1/agents/${agentId}/voice/transcriptions`;
const publicOrigin = "https://everything.test";
const bearer = { authorization: "Bearer owner-token" };

/** Any use of an unrelated dependency fails the test. */
function unusedOperations<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => () =>
        assert.fail(`Voice tests invoked ${String(property)}`),
    },
  ) as T;
}

/** A self-hosted speech service stand-in that records each upload it receives. */
async function speechService(
  context: TestContext,
  reply: (response: ServerResponse) => void = (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: " Draft this reply. " }));
  },
) {
  const uploads: { authorization?: string; wave: Buffer }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": request.headers["content-type"] ?? "" },
    }).formData();
    const file = form.get("file") as File;
    uploads.push({
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {}),
      wave: Buffer.from(await file.arrayBuffer()),
    });
    reply(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/audio/transcriptions`, uploads };
}

/** Bearer tokens the test verifier accepts, by subject. */
const tokens: Readonly<Record<string, string>> = {
  "owner-token": "owner",
  "second-token": "second-owner",
  "third-token": "third-owner",
};

/** The production HTTP application with real voice input and fake identity and teammates. */
async function application(
  context: TestContext,
  service: VoiceSettings["service"],
  decoder?: Parameters<typeof createVoiceRuntime>[3],
) {
  const documentation = new ApiDocumentationService();
  const runtime = await createVoiceRuntime(
    {
      service,
      stream: null,
      admission: { concurrency: 1, queueLimit: 1, queueTimeoutMs: 5_000 },
    },
    {
      /** Each owner has the teammate; every other ID is missing or foreign. */
      async get(ownerId, id) {
        if (!Object.values(tokens).includes(ownerId) || id !== agentId)
          throw new AgentNotFoundError();
        return { id } as AgentDefinition;
      },
    },
    () => undefined,
    ...(decoder ? [decoder] : []),
  );
  const created = runtime.uploads;
  const reservedOwners: string[] = [];
  const voice: HttpDependencies["voice"] = {
    capabilities: () => created.capabilities(),
    /** Record each reservation so tests can wait for one deterministically. */
    reserve: (ownerId) => {
      const reservation = created.reserve(ownerId);
      reservedOwners.push(ownerId);
      return reservation;
    },
    transcribe: (...parameters) => created.transcribe(...parameters),
  };
  const dependencies: HttpDependencies = {
    apiDocumentation: documentation,
    verifier: {
      /** Accept only the test tokens. */
      verify: async (token) => {
        const subject = tokens[token];
        if (!subject) throw new Error("invalid");
        return { subject };
      },
    },
    sessions: {
      ...unusedOperations<HttpDependencies["sessions"]>(),
      /** A browser session whose cookie carries the owner's token. */
      resolve: async (handle) =>
        handle === "browser-session"
          ? {
              accessToken: "owner-token",
              profile: { subject: "owner", displayName: "Owner" },
            }
          : undefined,
    },
    publicOrigin,
    chatGptRedirectUri: "http://127.0.0.1:8080/v1/providers/chatgpt/callback",
    keys: unusedOperations(),
    credentialGrants: unusedOperations(),
    credentialRollouts: unusedOperations(),
    providers: unusedOperations(),
    models: unusedOperations(),
    agents: unusedOperations(),
    agentActivity: unusedOperations(),
    profiles: unusedOperations(),
    removal: unusedOperations(),
    conversations: unusedOperations(),
    subagents: unusedOperations(),
    updates: unusedOperations(),
    upgrades: unusedOperations(),
    artifacts: unusedOperations(),
    workers: unusedOperations(),
    generalSettings: unusedOperations(),
    teammateOrder: unusedOperations(),
    workspaces: unusedOperations(),
    workspaceActivity: unusedOperations(),
    voice,
    voiceStreams: runtime.streams,
    telemetry: new TelemetryQueryService(
      { enabled: false, retentionDays: 7 },
      null,
    ),
    readiness: async () => {},
  };
  const app = await createHttpApplication(dependencies);
  app.addHook("preClose", async () => runtime.close());
  context.after(() => app.close());
  return { app, documentation, reservedOwners };
}

/** A configured speech service at the given URL. */
function configured(url: string): NonNullable<VoiceSettings["service"]> {
  return { url, token: "service-secret", model: "", timeoutMs: 10_000 };
}

test("requires authentication and a same-origin browser request, and is never cached", async (context) => {
  const speech = await speechService(context);
  const { app } = await application(context, configured(speech.url));
  for (const request of [
    { method: "GET" as const, url: "/v1/voice/capabilities" },
    {
      method: "POST" as const,
      url: route,
      headers: { "content-type": "audio/webm" },
      payload: Buffer.alloc(16),
    },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 401);
  }
  const crossSite = await app.inject({
    method: "POST",
    url: route,
    headers: {
      cookie: "__Host-everything-session=browser-session",
      "content-type": "audio/webm",
      origin: "https://elsewhere.test",
    },
    payload: Buffer.alloc(16),
  });
  assert.equal(crossSite.statusCode, 403);
  const capabilities = await app.inject({
    url: "/v1/voice/capabilities",
    headers: bearer,
  });
  assert.equal(capabilities.statusCode, 200);
  assert.equal(capabilities.headers["cache-control"], "no-store");
  assert.equal(capabilities.json().available, true);
  assert.ok(!JSON.stringify(capabilities.json()).includes("127.0.0.1"));
  assert.ok(!JSON.stringify(capabilities.json()).includes("service-secret"));
  assert.equal(speech.uploads.length, 0);
});

test(
  "decodes a real recording, uploads 16 kHz mono WAVE with the private token, and returns the transcript",
  { skip: ffmpegMissing },
  async (context) => {
    const speech = await speechService(context);
    const { app } = await application(context, configured(speech.url));
    const response = await app.inject({
      method: "POST",
      url: route,
      headers: { ...bearer, "content-type": "audio/webm;codecs=opus" },
      payload: syntheticRecording("webm", { seconds: 2 }),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { text: "Draft this reply." });
    assert.equal(response.headers["cache-control"], "no-store");
    const [upload] = speech.uploads;
    assert.equal(upload?.authorization, "Bearer service-secret");
    assert.equal(upload?.wave.toString("latin1", 0, 4), "RIFF");
    assert.equal(upload?.wave.readUInt16LE(22), 1);
    assert.equal(upload?.wave.readUInt32LE(24), 16_000);
    assert.ok(Math.abs(upload!.wave.readUInt32LE(40) - 64_000) < 3_200);
  },
);

test(
  "rejects recordings over a minute by their decoded audio without contacting the speech service",
  { skip: ffmpegMissing },
  async (context) => {
    const speech = await speechService(context);
    const { app } = await application(context, configured(speech.url));
    const response = await app.inject({
      method: "POST",
      url: route,
      headers: { ...bearer, "content-type": "audio/ogg" },
      payload: syntheticRecording("ogg", { seconds: 61 }),
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().code, "VOICE_RECORDING_TOO_LONG");
    const silent = await app.inject({
      method: "POST",
      url: route,
      headers: { ...bearer, "content-type": "audio/ogg" },
      payload: syntheticRecording("ogg", { seconds: 2, silent: true }),
    });
    assert.deepEqual(silent.json(), { text: "" });
    assert.equal(speech.uploads.length, 0);
  },
);

test("missing and foreign teammates look identical and nothing is decoded or uploaded", async (context) => {
  const speech = await speechService(context);
  const { app } = await application(context, configured(speech.url));
  // One at a time: an owner has one recording in progress.
  const responses = [];
  for (const id of [foreignAgentId, "4c1f8c2e-1d0b-4b1e-9d77-1f6f1c1f6e8c"])
    responses.push(
      await app.inject({
        method: "POST",
        url: `/v1/agents/${id}/voice/transcriptions`,
        headers: { ...bearer, "content-type": "audio/webm" },
        payload: webmSignature(),
      }),
    );
  for (const response of responses) {
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), responses[0]!.json());
  }
  assert.equal(speech.uploads.length, 0);
});

test("without a configured service, voice input is reported unavailable and refused", async (context) => {
  const { app } = await application(context, null);
  const capabilities = await app.inject({
    url: "/v1/voice/capabilities",
    headers: bearer,
  });
  assert.equal(capabilities.json().available, false);
  const response = await app.inject({
    method: "POST",
    url: route,
    headers: { ...bearer, "content-type": "audio/webm" },
    payload: webmSignature(),
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "VOICE_UNAVAILABLE");
});

test("a configured service is unavailable when the decoder can't start", async () => {
  const warnings: string[] = [];
  const { uploads: voice } = await createVoiceRuntime(
    {
      service: configured("http://127.0.0.1:9/v1/audio/transcriptions"),
      stream: null,
      admission: { concurrency: 1, queueLimit: 0, queueTimeoutMs: 1_000 },
    },
    { get: async () => assert.fail("ownership must not be checked") },
    (message) => warnings.push(message),
    new FfmpegAudioDecoder({
      ffmpeg: "/nonexistent/ffmpeg",
      prlimit: "prlimit",
    }),
  );
  assert.equal(voice.capabilities().available, false);
  assert.equal(warnings.length, 1);
});

test("refuses a second upload per owner and uploads beyond the total before reading their bodies", async (context) => {
  const speech = await speechService(context);
  const { app, reservedOwners } = await application(
    context,
    configured(speech.url),
    {
      verify: async () => true,
      decode: async () => {
        throw new VoiceRecordingInvalidError();
      },
    },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  // Paused uploads are destroyed before the test ends, since closing the server waits for them.
  const open: ClientRequest[] = [];
  try {
    // Two owners each start a full-size upload and pause after 16 bytes, holding both places.
    const first = slowUpload(port, "owner-token");
    open.push(first.request);
    await eventually(() => reservedOwners.includes("owner"));
    const second = slowUpload(port, "second-token");
    open.push(second.request);
    await eventually(() => reservedOwners.includes("second-owner"));

    // Both refusals arrive while each refused upload has sent only 16 of its 8 MiB.
    const sameOwner = slowUpload(port, "owner-token");
    const overTotal = slowUpload(port, "third-token");
    open.push(sameOwner.request, overTotal.request);
    const busy = await sameOwner.response;
    assert.equal(busy.status, 429);
    assert.equal(JSON.parse(busy.body).code, "VOICE_BUSY");
    const full = await overTotal.response;
    assert.equal(full.status, 503);
    assert.equal(JSON.parse(full.body).code, "VOICE_CAPACITY");

    // When the first caller disconnects, its place is released and the owner can upload again.
    first.request.destroy();
    let retry: { status: number; body: string } = { status: 429, body: "" };
    for (let attempt = 0; attempt < 100 && retry.status === 429; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: { ...bearer, "content-type": "audio/webm" },
        body: webmSignature(),
      });
      retry = { status: response.status, body: await response.text() };
      if (retry.status === 429)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(retry.status, 400);
    assert.equal(JSON.parse(retry.body).code, "VOICE_RECORDING_INVALID");
    assert.equal(speech.uploads.length, 0);
  } finally {
    open.forEach((request) => request.destroy());
  }
});

test("the API definition documents both routes and the raw recording body", async (context) => {
  const { app, documentation } = await application(context, null);
  await app.ready();
  const definition = documentation.read();
  await SwaggerParser.validate(structuredClone(definition));
  const full = (await SwaggerParser.dereference(
    structuredClone(definition),
  )) as OpenAPIV3.Document;
  const capabilities = full.paths["/v1/voice/capabilities"]!.get!;
  assert.ok(capabilities.summary);
  assert.ok(capabilities.responses["200"]);
  const upload = full.paths["/v1/agents/{agentId}/voice/transcriptions"]!.post!;
  assert.ok(upload.summary);
  assert.match(upload.description!, /not stored/);
  const body = upload.requestBody as OpenAPIV3.RequestBodyObject;
  assert.deepEqual(Object.keys(body.content).sort(), [
    "audio/mp4",
    "audio/ogg",
    "audio/webm",
  ]);
  assert.equal(
    (body.content["audio/webm"]!.schema as OpenAPIV3.SchemaObject).format,
    "binary",
  );
  const result = upload.responses["200"] as OpenAPIV3.ResponseObject;
  const schema = result.content!["application/json"]!
    .schema as OpenAPIV3.SchemaObject;
  assert.equal(
    (schema.properties!.text as OpenAPIV3.SchemaObject).maxLength,
    32_000,
  );
});

/** An upload that declares a full-size recording but sends only its first bytes, then waits. */
function slowUpload(
  port: number,
  token: string,
): {
  request: ClientRequest;
  response: Promise<{ status: number; body: string }>;
} {
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: route,
    agent: false,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "audio/webm",
      "content-length": 8 * 1024 * 1024,
    },
  });
  const response = new Promise<{ status: number; body: string }>((resolve) =>
    request.on("response", async (incoming) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      resolve({
        status: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    }),
  );
  request.on("error", () => undefined);
  request.write(webmSignature());
  return { request, response };
}

/** Wait until a condition holds, failing after a few seconds. */
async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition());
}

/** Bytes with the WebM signature; availability and ownership are checked before decoding. */
function webmSignature(): Buffer<ArrayBuffer> {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 1, 2, 3, 4]);
}
