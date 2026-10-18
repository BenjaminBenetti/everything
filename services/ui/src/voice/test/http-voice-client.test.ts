import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthenticatedTransport } from "../../http/adapter/authenticated-transport.js";
import { HttpVoiceClient } from "../adapter/http-voice-client.js";
import { VoiceInputError } from "../model/voice-input-error.js";

const audio = {
  blob: new Blob(["recording"]),
  type: "audio/mp4;codecs=mp4a.40.2",
};

test("uploads the raw recording once to the teammate's route with its own content type", async () => {
  const requests: { path: string; options: RequestInit }[] = [];
  const client = new HttpVoiceClient(
    createAuthenticatedTransport(async (input, options = {}) => {
      requests.push({ path: String(input), options });
      return Response.json(
        String(input).endsWith("capabilities")
          ? { available: true }
          : { text: "Draft this reply." },
      );
    }),
  );
  assert.equal((await client.capabilities()).available, true);
  const signal = new AbortController().signal;
  assert.equal(
    await client.transcribe("team mate/1", audio, signal),
    "Draft this reply.",
  );
  const upload = requests[1]!;
  assert.equal(upload.path, "/v1/agents/team%20mate%2F1/voice/transcriptions");
  assert.equal(upload.options.method, "POST");
  assert.equal(upload.options.body, audio.blob);
  assert.equal(upload.options.signal, signal);
  const headers = new Headers(upload.options.headers);
  assert.equal(headers.get("Content-Type"), "audio/mp4;codecs=mp4a.40.2");
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Authorization"), null);
  assert.equal(upload.options.credentials, "same-origin");
  assert.equal(upload.options.cache, "no-store");
  assert.equal(upload.options.redirect, "error");
  assert.equal(requests.length, 2);
});

test("describes failures by status alone and never retries", async () => {
  for (const [status, notice] of [
    [401, "sessionExpired"],
    [404, "teammateMissing"],
    [413, "tooLarge"],
    [415, "failed"],
    [429, "busy"],
    [502, "failed"],
    [503, "unavailable"],
    [504, "timedOut"],
  ] as const) {
    let calls = 0;
    const client = new HttpVoiceClient(
      createAuthenticatedTransport(async () => {
        calls++;
        return Response.json(
          { message: "private upstream detail" },
          { status },
        );
      }),
    );
    await assert.rejects(
      client.transcribe("agent", audio, new AbortController().signal),
      (error) =>
        error instanceof VoiceInputError &&
        error.notice === notice &&
        !error.message.includes("private"),
      String(status),
    );
    assert.equal(calls, 1);
  }
});

test("an aborted upload stops the request", async () => {
  const abort = new AbortController();
  let seen: AbortSignal | undefined;
  const client = new HttpVoiceClient(
    createAuthenticatedTransport(
      (_input, options = {}) =>
        new Promise((_resolve, reject) => {
          seen = options.signal ?? undefined;
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ),
  );
  const pending = client.transcribe("agent", audio, abort.signal);
  abort.abort();
  await assert.rejects(pending, VoiceInputError);
  assert.equal(seen?.aborted, true);
});
