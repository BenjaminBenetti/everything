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

/** Whether this installation transcribes recordings, and the limits it applies to them. */
export interface VoiceCapabilities {
  readonly available: boolean;
  readonly maxDurationMs: number;
  readonly maxBytes: number;
  readonly mediaTypes: readonly VoiceMediaType[];
  /** Longest the server may take to answer one transcription, including waiting for capacity. */
  readonly responseTimeoutMs: number;
}

/** A finished transcript; empty when the recording contained no recognizable speech. */
export interface VoiceTranscript {
  readonly text: string;
}
