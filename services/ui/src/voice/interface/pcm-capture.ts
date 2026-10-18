import type { MediaStreamLike, RecordingBlocker } from "./media-environment.js";

/** The capture worklet's message port, as the main thread sees it. */
export interface CapturePort {
  postMessage(message: unknown): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

/** An audio graph that runs the capture worklet on a microphone stream. */
export interface CaptureGraph {
  /** The rate the graph actually runs at; capture needs 16 kHz. */
  readonly sampleRate: number;
  /** Load the worklet, connect the microphone to it, and start rendering. */
  start(stream: MediaStreamLike): Promise<CapturePort>;
  /** Stop rendering and release the graph. */
  close(): void;
}

/** Microphone access and audio graphs for streaming capture, replaceable in tests. */
export interface PcmCaptureEnvironment {
  /** Null when the page can capture PCM with an audio worklet. */
  readonly blocker: RecordingBlocker | null;
  /** Ask for the microphone; the browser may prompt for permission. */
  getUserMedia(): Promise<MediaStreamLike>;
  /** Create a graph that runs at 16 kHz if the browser allows it. */
  createGraph(): CaptureGraph;
}

/** Receives captured PCM frames in order. */
export interface PcmSink {
  write(samples: Int16Array): void;
}
