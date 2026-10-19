/**
 * Voice streaming protocol, version 1: the browser streams PCM while the microphone is held, and the
 * speech service returns one final transcript after an explicit end. The gateway and the internal
 * speech service speak the same messages. Field names and framing are frozen; change them only by
 * agreement with the speech service.
 */

/** The protocol version every start and ready message carries. */
export const voiceStreamVersion = 1;

/** Fixed audio format: 16 kHz, mono, signed 16-bit little-endian PCM. */
export const voiceStreamAudio = {
  sampleRate: 16_000,
  channels: 1,
  format: "pcm_s16le",
} as const;

/** Bounds both ends of a stream enforce. */
export const voiceStreamLimits = {
  /** Most samples in one stream: 60 seconds. */
  maxSamples: 960_000,
  /** Most samples in one audio message. */
  maxFrameSamples: 3_200,
  /** Samples per audio message the browser sends: 20 ms. */
  frameSamples: 320,
  /** Most samples sent but not yet acknowledged. */
  windowSamples: 16_000,
  /** Most audio messages in one stream. */
  maxMessages: 6_000,
  /** Largest text message, in UTF-8 bytes. */
  maxControlBytes: 1_024,
  /** Bytes of the sequence number that starts every audio message. */
  sequenceBytes: 4,
  /** Largest audio message: the sequence number and a full frame. */
  maxAudioBytes: 4 + 3_200 * 2,
} as const;

/** Error codes a stream may end with; nothing else is ever sent. */
export const voiceStreamErrorCodes = [
  "INVALID_MESSAGE",
  "INVALID_SEQUENCE",
  "INVALID_AUDIO",
  "TOO_LONG",
  "BUSY",
  "UNAVAILABLE",
  "BACKPRESSURE",
  "TIMEOUT",
] as const;

/** A safe stream error code. */
export type VoiceStreamErrorCode = (typeof voiceStreamErrorCodes)[number];

// ===========================================
// Client to service
// ===========================================

/** Opens the stream; sent once, before any audio. */
export interface VoiceStreamStart {
  readonly type: "start";
  readonly version: typeof voiceStreamVersion;
  readonly sampleRate: typeof voiceStreamAudio.sampleRate;
  readonly channels: typeof voiceStreamAudio.channels;
  readonly format: typeof voiceStreamAudio.format;
}

/** Follows the last audio message: `sequence` is the next expected sequence, the audio message count. */
export interface VoiceStreamEnd {
  readonly type: "end";
  readonly sequence: number;
  readonly totalSamples: number;
}

/** Abandons the stream; idempotent. */
export interface VoiceStreamCancel {
  readonly type: "cancel";
}

/** A text message from the client. */
export type VoiceStreamClientMessage =
  VoiceStreamStart | VoiceStreamEnd | VoiceStreamCancel;

// ===========================================
// Service to client
// ===========================================

/** The stream is admitted and the speech service is ready for audio. */
export interface VoiceStreamReady {
  readonly type: "ready";
  readonly version: typeof voiceStreamVersion;
  readonly maxSamples: number;
  readonly maxFrameSamples: number;
  readonly windowSamples: number;
}

/** Audio messages up to and including `sequence` have been processed. */
export interface VoiceStreamAck {
  readonly type: "ack";
  readonly sequence: number;
}

/** The one stable transcript, after end; empty when nothing was recognized. */
export interface VoiceStreamFinal {
  readonly type: "final";
  readonly text: string;
}

/** Cancellation has finished and the speech service's work for the stream has stopped. */
export interface VoiceStreamCancelled {
  readonly type: "cancelled";
}

/** The stream failed; terminal. */
export interface VoiceStreamError {
  readonly type: "error";
  readonly code: VoiceStreamErrorCode;
}

/** A text message from the service. */
export type VoiceStreamServiceMessage =
  | VoiceStreamReady
  | VoiceStreamAck
  | VoiceStreamFinal
  | VoiceStreamCancelled
  | VoiceStreamError;

/** The start message every stream begins with. */
export const voiceStreamStart: VoiceStreamStart = {
  type: "start",
  version: voiceStreamVersion,
  ...voiceStreamAudio,
};

// ===========================================
// Audio framing
// ===========================================

/** Encode one audio message: the sequence as uint32 little-endian, then the samples. */
export function encodeVoiceFrame(
  sequence: number,
  samples: Int16Array,
): ArrayBuffer {
  const frame = new ArrayBuffer(
    voiceStreamLimits.sequenceBytes + samples.length * 2,
  );
  const view = new DataView(frame);
  view.setUint32(0, sequence, true);
  for (let index = 0; index < samples.length; index++)
    view.setInt16(
      voiceStreamLimits.sequenceBytes + index * 2,
      samples[index]!,
      true,
    );
  return frame;
}

/** A decoded audio message. */
export interface VoiceFrame {
  readonly sequence: number;
  readonly samples: number;
}

/**
 * Read an audio message's sequence and sample count, or null when its length is outside 1 to 3200
 * whole samples. The samples themselves are passed on unchanged.
 */
export function decodeVoiceFrame(frame: Uint8Array): VoiceFrame | null {
  const { sequenceBytes, maxAudioBytes } = voiceStreamLimits;
  if (
    frame.byteLength < sequenceBytes + 2 ||
    frame.byteLength > maxAudioBytes ||
    (frame.byteLength - sequenceBytes) % 2 !== 0
  )
    return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    sequence: view.getUint32(0, true),
    samples: (frame.byteLength - sequenceBytes) / 2,
  };
}

// ===========================================
// Message validation
// ===========================================

/** Parse a text message's JSON object, or null when it isn't one within the size limit. */
function parseObject(text: string): Record<string, unknown> | null {
  if (
    new TextEncoder().encode(text).byteLength >
    voiceStreamLimits.maxControlBytes
  )
    return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True when the object has exactly these keys. */
function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => key in value);
}

/** A whole number within a range. */
function isCount(value: unknown, max: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max
  );
}

/** Parse a client text message, accepting only the exact v1 shapes. */
export function parseVoiceClientMessage(
  text: string,
): VoiceStreamClientMessage | null {
  const value = parseObject(text);
  if (!value) return null;
  switch (value.type) {
    case "start":
      return hasExactKeys(value, [
        "type",
        "version",
        "sampleRate",
        "channels",
        "format",
      ]) &&
        value.version === voiceStreamVersion &&
        value.sampleRate === voiceStreamAudio.sampleRate &&
        value.channels === voiceStreamAudio.channels &&
        value.format === voiceStreamAudio.format
        ? voiceStreamStart
        : null;
    case "end":
      return hasExactKeys(value, ["type", "sequence", "totalSamples"]) &&
        isCount(value.sequence, voiceStreamLimits.maxMessages) &&
        isCount(value.totalSamples, voiceStreamLimits.maxSamples)
        ? {
            type: "end",
            sequence: value.sequence,
            totalSamples: value.totalSamples,
          }
        : null;
    case "cancel":
      return hasExactKeys(value, ["type"]) ? { type: "cancel" } : null;
    default:
      return null;
  }
}

/**
 * Parse a service text message, accepting only the exact v1 shapes. Ready limits above the product's
 * own are refused, so a service can never raise them. Final text is accepted up to `maxText`
 * characters; `maxBytes` bounds the message as received.
 */
export function parseVoiceServiceMessage(
  text: string,
  {
    maxText,
    maxBytes,
  }: { readonly maxText: number; readonly maxBytes: number },
): VoiceStreamServiceMessage | null {
  if (
    text.length > maxBytes ||
    new TextEncoder().encode(text).byteLength > maxBytes
  )
    return null;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const limits = voiceStreamLimits;
  switch (value.type) {
    case "ready":
      return hasExactKeys(value, [
        "type",
        "version",
        "maxSamples",
        "maxFrameSamples",
        "windowSamples",
      ]) &&
        value.version === voiceStreamVersion &&
        isCount(value.maxSamples, limits.maxSamples) &&
        (value.maxSamples as number) > 0 &&
        isCount(value.maxFrameSamples, limits.maxFrameSamples) &&
        (value.maxFrameSamples as number) > 0 &&
        isCount(value.windowSamples, limits.windowSamples) &&
        (value.windowSamples as number) > 0
        ? {
            type: "ready",
            version: voiceStreamVersion,
            maxSamples: value.maxSamples as number,
            maxFrameSamples: value.maxFrameSamples as number,
            windowSamples: value.windowSamples as number,
          }
        : null;
    case "ack":
      return hasExactKeys(value, ["type", "sequence"]) &&
        isCount(value.sequence, limits.maxMessages - 1)
        ? { type: "ack", sequence: value.sequence }
        : null;
    case "final":
      return hasExactKeys(value, ["type", "text"]) &&
        typeof value.text === "string" &&
        value.text.length <= maxText
        ? { type: "final", text: value.text }
        : null;
    case "cancelled":
      return hasExactKeys(value, ["type"]) ? { type: "cancelled" } : null;
    case "error":
      return hasExactKeys(value, ["type", "code"]) &&
        voiceStreamErrorCodes.includes(value.code as VoiceStreamErrorCode)
        ? { type: "error", code: value.code as VoiceStreamErrorCode }
        : null;
    default:
      return null;
  }
}
