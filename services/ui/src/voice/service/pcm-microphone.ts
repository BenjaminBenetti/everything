import { voiceStreamAudio } from "@everything/conversation-contracts/voice-stream";
import type { MediaStreamLike } from "../interface/media-environment.js";
import type {
  CaptureGraph,
  CapturePort,
  PcmCaptureEnvironment,
  PcmSink,
} from "../interface/pcm-capture.js";
import { VoiceInputError } from "../model/voice-input-error.js";
import { microphoneNotice } from "./microphone-recorder.js";

/** How long the worklet may take to hand over its last frame after a flush. */
const flushTimeoutMs = 2_000;

/** Limits and callbacks for one capture. */
export interface PcmMicrophoneOptions {
  /** Longest to capture before `onLimit` asks for the capture to be finished. */
  readonly maxDurationMs: number;
  /** The duration limit was reached; the caller finishes the capture. */
  onLimit(): void;
  /** Capture failed while no finish was pending; the microphone is already released. */
  onFailure(error: VoiceInputError): void;
}

/** What a finished capture produced: the samples the worklet emitted, all already written. */
export interface PcmCaptureEnd {
  readonly samples: number;
}

/**
 * One microphone capture through a 16 kHz audio worklet, writing PCM frames to a sink as they are
 * produced, independent of where they go. The graph is never torn down before the worklet confirms
 * its last frame, permission that arrives after a release or cancel starts nothing, and every path
 * stops the microphone and closes the graph.
 */
export class PcmMicrophone {
  private stage: "requesting" | "capturing" | "flushing" | "ended" =
    "requesting";
  private stream: MediaStreamLike | null = null;
  private graph: CaptureGraph | null = null;
  private port: CapturePort | null = null;
  private samples = 0;
  private limitTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private finishing: Promise<PcmCaptureEnd | null> | null = null;
  private pending:
    | {
        resolve(end: PcmCaptureEnd | null): void;
        reject(error: VoiceInputError): void;
      }
    | undefined;

  /** Capture from the environment's microphone into the sink. */
  constructor(
    private readonly environment: PcmCaptureEnvironment,
    private readonly sink: PcmSink,
    private readonly options: PcmMicrophoneOptions,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Request the microphone and start capturing. Resolves true once audio flows to the worklet, false
   * when the capture was finished or cancelled first; rejects when capture can't start.
   */
  async start(): Promise<boolean> {
    let stream: MediaStreamLike;
    try {
      stream = await this.environment.getUserMedia();
    } catch (error) {
      this.stage = "ended";
      throw new VoiceInputError(microphoneNotice(error));
    }
    this.stream = stream;
    if (this.stage !== "requesting") {
      this.release();
      return false;
    }
    let port: CapturePort;
    try {
      this.graph = this.environment.createGraph();
      // The graph must really run at 16 kHz; resampling is the browser's job, not this code's.
      if (this.graph.sampleRate !== voiceStreamAudio.sampleRate)
        throw new VoiceInputError("unsupported");
      port = await this.graph.start(stream);
    } catch (error) {
      // A capture already finished or cancelled while its graph was starting has nothing to report.
      const abandoned = this.stage !== "requesting";
      this.stage = "ended";
      this.release();
      if (abandoned) return false;
      throw error instanceof VoiceInputError
        ? error
        : new VoiceInputError("microphoneFailed");
    }
    if (this.stage !== "requesting") {
      port.postMessage({ type: "stop" });
      this.release();
      return false;
    }
    this.port = port;
    port.onmessage = (event) => this.receive(event.data);
    this.stage = "capturing";
    this.limitTimer = setTimeout(
      () => this.options.onLimit(),
      this.options.maxDurationMs,
    );
    return true;
  }

  /**
   * Stop capturing: the worklet sends its last, possibly short, frame, then confirms. Resolves with
   * the sample count once every frame has been written, or null when capture hadn't started.
   */
  finish(): Promise<PcmCaptureEnd | null> {
    if (this.finishing) return this.finishing;
    if (this.stage === "requesting") {
      // Release whatever exists now, including a granted microphone whose graph is still starting;
      // start() releases anything that arrives later.
      this.stage = "ended";
      this.release();
      return Promise.resolve(null);
    }
    if (this.stage !== "capturing" || !this.port) return Promise.resolve(null);
    this.stage = "flushing";
    clearTimeout(this.limitTimer);
    this.finishing = new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.flushTimer = setTimeout(
        () => this.fail(new VoiceInputError("microphoneFailed")),
        flushTimeoutMs,
      );
      this.port!.postMessage({ type: "flush" });
    });
    return this.finishing;
  }

  /** Stop at once; nothing more is written or reported. */
  cancel(): void {
    if (this.stage === "ended") return;
    this.stage = "ended";
    this.port?.postMessage({ type: "stop" });
    this.release();
    this.pending?.resolve(null);
    this.pending = undefined;
  }

  // ===========================================
  // Worklet messages
  // ===========================================

  /** Write a frame and return its credit, fail on overflow, or end on the flush confirmation. */
  private receive(message: unknown): void {
    if (this.stage !== "capturing" && this.stage !== "flushing") return;
    const data = message as { type?: string; samples?: unknown };
    if (data.type === "frame" && data.samples instanceof Int16Array) {
      this.port?.postMessage({ type: "credit", frames: 1 });
      this.samples += data.samples.length;
      try {
        this.sink.write(data.samples);
      } catch (error) {
        this.fail(
          error instanceof VoiceInputError
            ? error
            : new VoiceInputError("fellBehind"),
        );
      }
    } else if (data.type === "overflow")
      this.fail(new VoiceInputError("fellBehind"));
    else if (data.type === "flushed" && this.stage === "flushing") {
      this.stage = "ended";
      this.release();
      // The worklet's count and the frames written must agree; anything else lost audio.
      if (data.samples !== this.samples)
        this.settle(new VoiceInputError("fellBehind"));
      else this.settle({ samples: this.samples });
    }
  }

  /** End with an error, releasing the microphone. */
  private fail(error: VoiceInputError): void {
    if (this.stage === "ended") return;
    this.stage = "ended";
    this.port?.postMessage({ type: "stop" });
    this.release();
    if (this.pending) this.settle(error);
    else this.options.onFailure(error);
  }

  /** Settle a pending finish once. */
  private settle(result: PcmCaptureEnd | VoiceInputError): void {
    clearTimeout(this.flushTimer);
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    if (result instanceof VoiceInputError) pending.reject(result);
    else pending.resolve(result);
  }

  /** Stop every microphone track and close the graph. */
  private release(): void {
    clearTimeout(this.limitTimer);
    clearTimeout(this.flushTimer);
    if (this.port) this.port.onmessage = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.graph?.close();
    this.stream = null;
    this.graph = null;
  }
}
