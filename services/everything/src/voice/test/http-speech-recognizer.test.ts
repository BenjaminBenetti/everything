import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { HttpSpeechRecognizer } from "../adapter/http-speech-recognizer.js";
import {
  VoiceTimeoutError,
  VoiceTranscriptionFailedError,
} from "../error/voice-errors.js";
import { waveFile } from "../model/pcm-audio.js";

/** One request as the fake speech service received it. */
interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
  readonly form: FormData;
}

/** A stand-in for a self-hosted OpenAI-compatible transcription server on a local port. */
async function speechService(
  context: TestContext,
  answer: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; received: Received[]; closed: Promise<void> }> {
  const received: Received[] = [];
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    received.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      accept: request.headers.accept,
      form: await new Response(Buffer.concat(chunks), {
        headers: { "content-type": request.headers["content-type"] ?? "" },
      }).formData(),
    });
    response.once("close", markClosed);
    answer(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
    received,
    closed,
  };
}

/** A recognizer for the service with the given optional settings. */
function recognizer(
  url: string,
  settings: { token?: string; model?: string; timeoutMs?: number } = {},
): HttpSpeechRecognizer {
  return new HttpSpeechRecognizer({
    url,
    token: settings.token ?? "",
    model: settings.model ?? "",
    timeoutMs: settings.timeoutMs ?? 5_000,
  });
}

/** Reply with a JSON body. */
function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const wave = waveFile(Buffer.alloc(3200, 1));

test("uploads the WAVE recording as a multipart file with the configured model and token", async (context) => {
  const service = await speechService(context, (_request, response) =>
    json(response, { text: "Hello there.", usage: { seconds: 1 } }),
  );
  const text = await recognizer(service.url, {
    token: "service-token",
    model: "speech-model-q8",
  }).transcribe(wave, new AbortController().signal);
  assert.equal(text, "Hello there.");
  const [request] = service.received;
  assert.equal(request?.path, "/v1/audio/transcriptions");
  assert.equal(request?.authorization, "Bearer service-token");
  assert.equal(request?.accept, "application/json");
  const file = request?.form.get("file");
  assert.ok(file instanceof File);
  assert.equal(file.name, "recording.wav");
  assert.equal(file.type, "audio/wav");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(wave));
  assert.equal(request?.form.get("model"), "speech-model-q8");
  assert.equal(request?.form.get("response_format"), "json");
});

test("sends no token or model when none is configured", async (context) => {
  const service = await speechService(context, (_request, response) =>
    json(response, { text: "" }),
  );
  assert.equal(
    await recognizer(service.url).transcribe(
      wave,
      new AbortController().signal,
    ),
    "",
  );
  assert.equal(service.received[0]?.authorization, undefined);
  assert.equal(service.received[0]?.form.has("model"), false);
});

test("never follows redirects or retries, and never exposes the service's answer", async (context) => {
  const target = await speechService(context, (_request, response) =>
    json(response, { text: "redirected" }),
  );
  const redirecting = await speechService(context, (_request, response) => {
    response.writeHead(307, { location: target.url });
    response.end();
  });
  await assert.rejects(
    recognizer(redirecting.url, { token: "service-token" }).transcribe(
      wave,
      new AbortController().signal,
    ),
    VoiceTranscriptionFailedError,
  );
  assert.equal(redirecting.received.length, 1);
  assert.equal(target.received.length, 0);
  const failing = await speechService(context, (_request, response) =>
    json(response, { error: "model crashed at /models/private-path" }, 500),
  );
  await assert.rejects(
    recognizer(failing.url).transcribe(wave, new AbortController().signal),
    (error) =>
      error instanceof VoiceTranscriptionFailedError &&
      !error.message.includes("private-path"),
  );
  assert.equal(failing.received.length, 1);
});

test("rejects answers that are not a bounded JSON transcript", async (context) => {
  for (const reply of [
    (response: ServerResponse) => response.end("plain words"),
    (response: ServerResponse) => json(response, { transcript: "wrong field" }),
    (response: ServerResponse) => json(response, { text: 42 }),
    (response: ServerResponse) => json(response, null),
    (response: ServerResponse) => json(response, { text: "x".repeat(32_001) }),
    (response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      // Larger than any valid answer; the reader must stop early.
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      for (let index = 0; index < 64; index++) response.write(chunk);
      response.end('{"text":"late"}');
    },
  ]) {
    const service = await speechService(context, (_request, response) =>
      reply(response),
    );
    await assert.rejects(
      recognizer(service.url).transcribe(wave, new AbortController().signal),
      VoiceTranscriptionFailedError,
    );
  }
});

test("times out at the configured deadline and stops when the caller aborts", async (context) => {
  const slow = await speechService(context, () => undefined);
  const started = Date.now();
  await assert.rejects(
    recognizer(slow.url, { timeoutMs: 1_000 }).transcribe(
      wave,
      new AbortController().signal,
    ),
    VoiceTimeoutError,
  );
  assert.ok(Date.now() - started < 4_000);
  await slow.closed;
  const waiting = await speechService(context, () => undefined);
  const abort = new AbortController();
  const result = recognizer(waiting.url, { timeoutMs: 60_000 }).transcribe(
    wave,
    abort.signal,
  );
  while (!waiting.received.length)
    await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  await assert.rejects(result, VoiceTranscriptionFailedError);
  // The upload's connection closes, so the service can stop working on it.
  await waiting.closed;
});
