/** Limits that the composer and the server both apply to one voice recording. */
export const voiceLimits = {
  /** Longest decoded recording the server transcribes. */
  maxDurationMs: 60_000,
  /** Largest encoded recording the server accepts. */
  maxBytes: 8 * 1024 * 1024,
} as const;

/** Container formats browsers record that the server decodes; parameters such as codecs are allowed. */
export const voiceMediaTypes = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
] as const;

/** A container format accepted for voice recordings. */
export type VoiceMediaType = (typeof voiceMediaTypes)[number];

/**
 * Whether this installation transcribes recordings, and the limits it applies to them. Two lanes
 * exist: streaming sends audio while the microphone is held; upload sends a finished recording.
 */
export interface VoiceCapabilities {
  /** Whether a finished recording can be uploaded for transcription. */
  readonly available: boolean;
  readonly maxDurationMs: number;
  readonly maxBytes: number;
  readonly mediaTypes: readonly VoiceMediaType[];
  /** Longest the server may take to answer one upload, including waiting for capacity. */
  readonly responseTimeoutMs: number;
  /** Whether audio can stream to a live speech service while the microphone is held. */
  readonly streaming: boolean;
  /** Longest the server waits for a stream's final transcript after its end. */
  readonly streamFinalTimeoutMs: number;
}

/** A finished transcript; empty when the recording contained no recognizable speech. */
export interface VoiceTranscript {
  readonly text: string;
}
