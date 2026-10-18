import type { VoiceCapabilities } from "@everything/conversation-contracts/voice";
import type { Dictation, DictationEvents } from "../interface/dictation.js";
import type { MediaEnvironment } from "../interface/media-environment.js";
import type { VoiceClient } from "../interface/voice-client.js";
import { uploadType } from "../model/recording-format.js";
import { VoiceInputError } from "../model/voice-input-error.js";
import { MicrophoneRecorder } from "./microphone-recorder.js";
import { RecordingBuffer } from "./recording-buffer.js";

/** Extra time the browser allows an upload beyond the server's own limit. */
const networkMarginMs = 15_000;

/** The upload lane: record with MediaRecorder, then upload the finished recording once. */
export class BatchDictation implements Dictation {
  private readonly buffer = new RecordingBuffer();
  private readonly recorder: MicrophoneRecorder;
  private readonly request = new AbortController();

  /** Record in `type` for a teammate, within the server's limits. */
  constructor(
    media: MediaEnvironment,
    private readonly client: VoiceClient,
    private readonly agentId: string,
    private readonly capabilities: VoiceCapabilities,
    private readonly type: string,
    events: DictationEvents & { readonly maxDurationMs: number },
  ) {
    this.recorder = new MicrophoneRecorder(media, this.buffer, {
      type,
      maxBytes: capabilities.maxBytes,
      maxDurationMs: events.maxDurationMs,
      onLimit: () => events.onLimit(),
      onFailure: (error) => events.onFailure(error),
    });
  }

  /** Start recording. */
  start(): Promise<boolean> {
    return this.recorder.start();
  }

  /** Stop, upload once, and resolve the transcript. */
  async finish(): Promise<string | null> {
    const end = await this.recorder.finish();
    const contentType =
      end && uploadType(end.type, this.type, this.capabilities.mediaTypes);
    const audio = contentType ? this.buffer.take(contentType) : null;
    this.buffer.discard();
    if (end && !contentType) throw new VoiceInputError("unsupported");
    if (!audio) return null;
    return this.client.transcribe(
      this.agentId,
      audio,
      withTimeout(
        this.request.signal,
        this.capabilities.responseTimeoutMs + networkMarginMs,
      ),
    );
  }

  /** Stop recording and abort the upload. */
  cancel(): void {
    this.recorder.cancel();
    this.request.abort();
  }
}

/** A signal that aborts with the given one or after a delay, also where `AbortSignal.any` is missing. */
function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([signal, timeout]);
  const combined = new AbortController();
  const abort = (): void => combined.abort();
  signal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return combined.signal;
}
