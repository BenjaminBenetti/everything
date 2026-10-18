/** A captured audio track. */
export interface AudioTrackLike {
  stop(): void;
}

/** A microphone stream. */
export interface MediaStreamLike {
  getTracks(): readonly AudioTrackLike[];
}

/** The parts of `MediaRecorder` dictation uses. */
export interface MediaRecorderLike {
  readonly mimeType: string;
  readonly state: string;
  start(timeslice?: number): void;
  stop(): void;
  addEventListener(
    type: "dataavailable",
    listener: (event: { readonly data: Blob }) => void,
  ): void;
  addEventListener(type: "error" | "stop", listener: () => void): void;
}

/** Why this page can't record, when it can't. */
export type RecordingBlocker = "insecure" | "unsupported";

/** Microphone capture and recording, replaceable in tests. */
export interface MediaEnvironment {
  /** Null when the page can record. */
  readonly blocker: RecordingBlocker | null;
  isTypeSupported(type: string): boolean;
  /** Ask for the microphone; the browser may prompt for permission. */
  getUserMedia(): Promise<MediaStreamLike>;
  createRecorder(
    stream: MediaStreamLike,
    options: { readonly mimeType: string; readonly audioBitsPerSecond: number },
  ): MediaRecorderLike;
}
