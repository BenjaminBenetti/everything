import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { voiceController } from "../controller/voice-controller.js";
import { VoiceBusyError } from "../error/voice-errors.js";
import type {
  VoiceOperations,
  VoiceRecording,
} from "../interface/voice-operations.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const route = `/agents/${agentId}/voice/transcriptions`;

/** One transcription that reached the use case. */
interface Call {
  ownerId: string;
  agentId: string;
  recording: VoiceRecording;
  signal: AbortSignal;
}

/**
 * Mount the controller beside an ordinary JSON route, recording what reaches the use case and which
 * owners hold reservations; a second reservation for the same owner is refused.
 */
async function fixture(
  transcribe?: VoiceOperations["transcribe"],
): Promise<{ app: FastifyInstance; calls: Call[]; reserved: Set<string> }> {
  const calls: Call[] = [];
  const reserved = new Set<string>();
  const app = authenticatedTestServer();
  app.post("/agents/:agentId/messages", async (request) => ({
    received: typeof request.body,
  }));
  await voiceController(app, {
    capabilities: () => ({
      available: true,
      maxDurationMs: 60_000,
      maxBytes: 8 * 1024 * 1024,
      mediaTypes: ["audio/webm", "audio/ogg", "audio/mp4"],
      responseTimeoutMs: 195_000,
    }),
    reserve(ownerId) {
      if (reserved.has(ownerId)) throw new VoiceBusyError();
      reserved.add(ownerId);
      return { ownerId, release: () => reserved.delete(ownerId) };
    },
    async transcribe(reservation, id, recording, signal) {
      calls.push({
        ownerId: reservation.ownerId,
        agentId: id,
        recording,
        signal,
      });
      return transcribe
        ? transcribe(reservation, id, recording, signal)
        : { text: "Draft this reply." };
    },
  });
  return { app, calls, reserved };
}

test("reports capabilities and passes the raw recording, its content type, and the subject", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  const capabilities = await app.inject({ url: "/voice/capabilities" });
  assert.equal(capabilities.statusCode, 200);
  assert.equal(capabilities.json().available, true);
  const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3]);
  const response = await app.inject({
    method: "POST",
    url: route,
    headers: { "content-type": "audio/webm;codecs=opus" },
    payload: bytes,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { text: "Draft this reply." });
  assert.equal(calls[0]?.ownerId, "owner");
  assert.equal(calls[0]?.agentId, agentId);
  assert.equal(calls[0]?.recording.contentType, "audio/webm;codecs=opus");
  assert.deepEqual(calls[0]?.recording.bytes, bytes);
});

test("accepts only recording media types up to the recording size limit", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  for (const contentType of [
    "audio/ogg",
    "audio/mp4",
    "AUDIO/MP4; codecs=mp4a.40.2",
  ]) {
    const response = await app.inject({
      method: "POST",
      url: route,
      headers: { "content-type": contentType },
      payload: Buffer.alloc(16),
    });
    assert.equal(response.statusCode, 200, contentType);
  }
  for (const [headers, payload] of [
    [{ "content-type": "application/json" }, JSON.stringify({ audio: "AAAA" })],
    [{ "content-type": "multipart/form-data; boundary=x" }, "--x--"],
    [{ "content-type": "text/plain" }, "words"],
    [{ "content-type": "audio/wav" }, "RIFF"],
    [{ "content-type": "application/octet-stream" }, "bytes"],
    [{}, "bytes"],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: route,
      headers,
      payload,
    });
    assert.equal(response.statusCode, 415, JSON.stringify(headers));
    assert.equal(response.json().code, "UNSUPPORTED_MEDIA_TYPE");
  }
  const tooLarge = await app.inject({
    method: "POST",
    url: route,
    headers: { "content-type": "audio/webm" },
    payload: Buffer.alloc(8 * 1024 * 1024 + 1),
  });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.json().code, "REQUEST_TOO_LARGE");
  const atLimit = await app.inject({
    method: "POST",
    url: route,
    headers: { "content-type": "audio/webm" },
    payload: Buffer.alloc(8 * 1024 * 1024),
  });
  assert.equal(atLimit.statusCode, 200);
  const invalidAgent = await app.inject({
    method: "POST",
    url: "/agents/not-a-teammate/voice/transcriptions",
    headers: { "content-type": "audio/webm" },
    payload: Buffer.alloc(16),
  });
  assert.equal(invalidAgent.statusCode, 400);
  assert.equal(calls.length, 4);
});

test("holds the owner's reservation until each response ends, including refusals", async (context) => {
  const { app, reserved } = await fixture();
  context.after(() => app.close());
  for (const [contentType, payload] of [
    ["audio/webm", Buffer.alloc(16)],
    ["application/json", Buffer.from("{}")],
    ["audio/webm", Buffer.alloc(8 * 1024 * 1024 + 1)],
  ] as const) {
    await app.inject({
      method: "POST",
      url: route,
      headers: { "content-type": contentType },
      payload,
    });
    assert.equal(reserved.size, 0, contentType);
  }
});

test("audio parsers and the larger body limit stay inside the voice route", async (context) => {
  const { app } = await fixture();
  context.after(() => app.close());
  const audio = await app.inject({
    method: "POST",
    url: `/agents/${agentId}/messages`,
    headers: { "content-type": "audio/webm" },
    payload: Buffer.alloc(16),
  });
  assert.equal(audio.statusCode, 415);
  const json = await app.inject({
    method: "POST",
    url: `/agents/${agentId}/messages`,
    payload: { text: "still JSON" },
  });
  assert.deepEqual(json.json(), { received: "object" });
});

test("a caller that disconnects aborts the transcription", async (context) => {
  let started: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (started = resolve));
  const { app, calls } = await fixture(
    (_ownerId, _agentId, _recording, signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  context.after(() => app.close());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const abort = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: Buffer.alloc(16),
    signal: abort.signal,
  }).catch((error: Error) => error.name);
  await reached;
  assert.equal(calls[0]?.signal.aborted, false);
  abort.abort();
  assert.equal(await request, "AbortError");
  for (let attempt = 0; attempt < 100 && !calls[0]?.signal.aborted; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls[0]?.signal.aborted, true);
});
