import type {
  MediaEnvironment,
  MediaRecorderLike,
  MediaStreamLike,
} from "../interface/media-environment.js";
import type { RecordingSink } from "../interface/recording-sink.js";
import { VoiceInputError } from "../model/voice-input-error.js";
import type { VoiceNotice } from "../model/voice-notice.js";

/** How often the recorder hands over captured audio, so its size can be checked as it grows. */
const timesliceMs = 1000;

/** Opus and AAC both carry clear speech at this rate, keeping a minute well under the upload limit. */
const audioBitsPerSecond = 32_000;

/** Limits and callbacks for one recording. */
export interface RecorderOptions {
  /** The format to request, already known to be supported and accepted. */
  readonly type: string;
  /** Most encoded bytes to capture before failing. */
  readonly maxBytes: number;
  /** Longest to record before `onLimit` asks for the recording to be finished. */
  readonly maxDurationMs: number;
  /** The duration limit was reached; the caller finishes the recording. */
  onLimit(): void;
  /** Recording failed while no finish was pending; the microphone is already released. */
  onFailure(error: VoiceInputError): void;
}

/** How a finished recording ended: the type its recorder produced. */
export interface RecordingEnd {
  readonly type: string;
}

/**
 * One microphone recording, from the permission request to the last chunk. It writes chunks to a
 * sink as they are captured and knows nothing about transcription. Whatever happens, including
 * permission arriving after the user let go or cancelled, every microphone track is stopped and no
 * recorder is started that nobody wants.
 */
export class MicrophoneRecorder {
  private stage: "requesting" | "recording" | "stopping" | "ended" =
    "requesting";
  private stream: MediaStreamLike | null = null;
  private recorder: MediaRecorderLike | null = null;
  private bytes = 0;
  private limitTimer: ReturnType<typeof setTimeout> | undefined;
  private pending:
    | {
        resolve(end: RecordingEnd | null): void;
        reject(error: VoiceInputError): void;
      }
    | undefined;

  /** Record from the environment's microphone into the sink. */
  constructor(
    private readonly media: MediaEnvironment,
    private readonly sink: RecordingSink,
    private readonly options: RecorderOptions,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Request the microphone and start recording. Resolves true once recording, or false when the
   * recording was finished or cancelled before permission arrived; rejects when it can't start.
   */
  async start(): Promise<boolean> {
    let stream: MediaStreamLike;
    try {
      stream = await this.media.getUserMedia();
    } catch (error) {
      this.stage = "ended";
      throw new VoiceInputError(microphoneNotice(error));
    }
    if (this.stage !== "requesting") {
      stopTracks(stream);
      return false;
    }
    this.stream = stream;
    try {
      const recorder = this.media.createRecorder(stream, {
        mimeType: this.options.type,
        audioBitsPerSecond,
      });
      this.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) =>
        this.receive(event.data),
      );
      recorder.addEventListener("error", () =>
        this.fail(new VoiceInputError("microphoneFailed")),
      );
      recorder.addEventListener("stop", () => this.stopped());
      recorder.start(timesliceMs);
    } catch {
      this.release();
      throw new VoiceInputError("unsupported");
    }
    this.stage = "recording";
    this.limitTimer = setTimeout(
      () => this.options.onLimit(),
      this.options.maxDurationMs,
    );
    return true;
  }

  /**
   * Stop recording and resolve how it ended, or null when nothing was captured, including when the
   * microphone was still being requested. Rejects if the recorder fails while stopping.
   */
  finish(): Promise<RecordingEnd | null> {
    if (this.stage === "requesting") {
      // start() releases the microphone when permission arrives.
      this.stage = "ended";
      return Promise.resolve(null);
    }
    if (this.stage !== "recording" || !this.recorder)
      return Promise.resolve(null);
    this.stage = "stopping";
    clearTimeout(this.limitTimer);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try {
        this.recorder!.stop();
      } catch {
        this.fail(new VoiceInputError("microphoneFailed"));
      }
    });
  }

  /** Stop at once and drop captured audio; nothing is reported. */
  cancel(): void {
    if (this.stage === "ended") return;
    this.stage = "ended";
    this.sink.discard();
    this.release();
    this.pending?.resolve(null);
    this.pending = undefined;
  }

  // ===========================================
  // Recorder events
  // ===========================================

  /** Pass a chunk on, failing once the recording passes its size limit. */
  private receive(chunk: Blob): void {
    if (this.stage !== "recording" && this.stage !== "stopping") return;
    if (!chunk.size) return;
    this.bytes += chunk.size;
    if (this.bytes > this.options.maxBytes)
      this.fail(new VoiceInputError("tooLarge"));
    else this.sink.write(chunk);
  }

  /** The recorder stopped: the expected end of a finish, or a failure such as a lost device. */
  private stopped(): void {
    if (this.stage === "recording") {
      this.fail(new VoiceInputError("microphoneFailed"));
      return;
    }
    if (this.stage !== "stopping") return;
    this.stage = "ended";
    const type = this.recorder?.mimeType || this.options.type;
    this.release();
    this.pending?.resolve(this.bytes ? { type } : null);
    this.pending = undefined;
  }

  /** End with an error, dropping captured audio and releasing the microphone. */
  private fail(error: VoiceInputError): void {
    if (this.stage === "ended") return;
    this.stage = "ended";
    this.sink.discard();
    this.release();
    if (this.pending) this.pending.reject(error);
    else this.options.onFailure(error);
    this.pending = undefined;
  }

  /** Stop the recorder and every microphone track. */
  private release(): void {
    clearTimeout(this.limitTimer);
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== "inactive")
      try {
        recorder.stop();
      } catch {
        // Already stopping; the tracks are stopped below either way.
      }
    if (this.stream) stopTracks(this.stream);
    this.stream = null;
  }
}

/** Stop every track so the browser's recording indicator turns off. */
function stopTracks(stream: MediaStreamLike): void {
  for (const track of stream.getTracks()) track.stop();
}

/** The outcome for a microphone request failure, by its DOMException name. */
function microphoneNotice(error: unknown): VoiceNotice {
  switch ((error as { name?: string } | null)?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permissionDenied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "noMicrophone";
    case "TypeError":
      return "unsupported";
    default:
      return "microphoneFailed";
  }
}
