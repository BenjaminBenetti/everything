import { messageTextMaxLength } from "@everything/conversation-contracts";
import { ApplicationError } from "@everything/errors";
import {
  VoiceTimeoutError,
  VoiceTranscriptionFailedError,
} from "../error/voice-errors.js";
import type { SpeechRecognizer } from "../interface/speech-recognizer.js";
import type { SpeechServiceSettings } from "../model/voice-settings.js";

/**
 * Largest response read from the service: a maximum-length transcript with every character escaped
 * in JSON, plus room for other fields.
 */
const maxResponseBytes = messageTextMaxLength * 6 + 64 * 1024;

/**
 * Sends finished recordings to the operator's self-hosted speech recognition service as a multipart
 * `file` upload, the request shape of OpenAI-compatible transcription servers, and reads back
 * `{ text }`. The endpoint, token, and model come only from deployment configuration. Requests are
 * never retried or redirected, and the service's responses never reach callers or logs.
 */
export class HttpSpeechRecognizer implements SpeechRecognizer {
  readonly available = true;

  // ===========================================
  // Construction
  // ===========================================

  /** Bind the configured service; the fetcher is replaceable for tests. */
  constructor(
    private readonly settings: SpeechServiceSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Upload one WAVE recording and return its final transcript. */
  async transcribe(
    wave: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<string> {
    const deadline = AbortSignal.timeout(this.settings.timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    try {
      const response = await this.fetcher(this.settings.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          ...(this.settings.token
            ? { authorization: `Bearer ${this.settings.token}` }
            : {}),
        },
        body: this.form(wave),
        redirect: "error",
        signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new VoiceTranscriptionFailedError();
      }
      return transcript(await readBounded(response));
    } catch (error) {
      if (deadline.aborted && !signal.aborted) throw new VoiceTimeoutError();
      if (error instanceof ApplicationError) throw error;
      throw new VoiceTranscriptionFailedError();
    }
  }

  // ===========================================
  // Service boundary
  // ===========================================

  /** The multipart request body: the recording and, when configured, the model to use. */
  private form(wave: Uint8Array<ArrayBuffer>): FormData {
    const form = new FormData();
    form.set("file", new Blob([wave], { type: "audio/wav" }), "recording.wav");
    if (this.settings.model) form.set("model", this.settings.model);
    form.set("response_format", "json");
    return form;
  }
}

/** Read the response body, refusing to buffer more than the largest valid answer. */
async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new VoiceTranscriptionFailedError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw new VoiceTranscriptionFailedError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/** Extract `text` from a JSON answer, rejecting anything else or a transcript too long for a message. */
function transcript(body: string): string {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    throw new VoiceTranscriptionFailedError();
  }
  const text = (answer as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.length > messageTextMaxLength)
    throw new VoiceTranscriptionFailedError();
  return text;
}
