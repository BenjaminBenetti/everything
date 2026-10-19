/**
 * Voice streaming protocol: the browser streams PCM while the microphone is held, and the speech
 * service returns one final transcript after an explicit end. The gateway and the internal speech
 * service speak the same messages. Field names and framing are frozen; change them only by agreement
 * with the speech service.
 *
 * Version 1 returns only the final. Version 2 is version 1 plus `partial` messages: the service's
 * provisional transcript while audio streams, which the final then replaces once. Peers agree on a
 * version before start, so a version 1 peer never sees anything but version 1:
 * - Browser to gateway: the browser offers both WebSocket subprotocols, version 1 first; a gateway
 *   that predates version 2 selects the first offer, and one that speaks it selects version 2.
 * - Gateway to speech service: a service that speaks version 2 lists its versions in the upgrade
 *   response's {@link voiceStreamVersionsHeader}; without it, the gateway starts version 1.
 */

/** Protocol versions: 1 returns only a final; 2 adds partial transcripts while audio streams. */
export const voiceStreamVersions = [1, 2] as const;

/** A protocol version. */
export type VoiceStreamVersion = (typeof voiceStreamVersions)[number];

/** The original version, which every peer speaks. */
export const voiceStreamVersion = 1;

/** The version that adds partial transcripts. */
export const voiceStreamLiveVersion = 2;

/**
 * WebSocket subprotocol for each version, between browser and gateway. Browsers offer them in this
 * order, so a gateway that selects the first offer speaks version 1.
 */
export const voiceStreamProtocols = {
  1: "voice-stream.1",
  2: "voice-stream.2",
} as const satisfies Record<VoiceStreamVersion, string>;

/** The version a negotiated subprotocol names; anything else, including none, is version 1. */
export function voiceStreamProtocolVersion(
  protocol: string,
): VoiceStreamVersion {
  return protocol === voiceStreamProtocols[2] ? 2 : 1;
}

/**
 * Upgrade response header in which a speech service lists the versions it speaks, such as `1, 2`.
 * A service without it speaks only version 1.
 */
export const voiceStreamVersionsHeader = "voice-stream-versions";

/** Whether a speech service's version header includes the version with partial transcripts. */
export function speaksLiveVersion(header: string | undefined): boolean {
  return (
    !!header &&
    header.length <= 64 &&
    header.split(",").some((version) => version.trim() === "2")
  );
}

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

/** Opens the stream; sent once, before any audio, with the agreed version. */
export interface VoiceStreamStart {
  readonly type: "start";
  readonly version: VoiceStreamVersion;
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

/** The stream is admitted and the speech service is ready for audio; carries start's version. */
export interface VoiceStreamReady {
  readonly type: "ready";
  readonly version: VoiceStreamVersion;
  readonly maxSamples: number;
  readonly maxFrameSamples: number;
  readonly windowSamples: number;
}

/** Audio messages up to and including `sequence` have been processed. */
export interface VoiceStreamAck {
  readonly type: "ack";
  readonly sequence: number;
}

/**
 * Version 2 only: the provisional transcript of everything heard so far, which later partials
 * revise and the final replaces. Revisions only increase; one may be skipped, since each partial
 * replaces the last. It is never stable text: an acknowledgement or partial says nothing about which
 * words the final will keep.
 */
export interface VoiceStreamPartial {
  readonly type: "partial";
  readonly revision: number;
  readonly text: string;
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
  | VoiceStreamPartial
  | VoiceStreamFinal
  | VoiceStreamCancelled
  | VoiceStreamError;

/** The version 1 start message. */
export const voiceStreamStart: VoiceStreamStart = {
  type: "start",
  version: voiceStreamVersion,
  ...voiceStreamAudio,
};

/** The start message for a version. */
export function voiceStreamStartFor(
  version: VoiceStreamVersion,
): VoiceStreamStart {
  return { ...voiceStreamStart, version };
}

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

/** A known protocol version. */
function isVersion(value: unknown): value is VoiceStreamVersion {
  return voiceStreamVersions.includes(value as VoiceStreamVersion);
}

/**
 * Parse a client text message, accepting only the exact shapes. Start may carry either version; the
 * receiver checks it against the version agreed for the connection.
 */
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
        isVersion(value.version) &&
        value.sampleRate === voiceStreamAudio.sampleRate &&
        value.channels === voiceStreamAudio.channels &&
        value.format === voiceStreamAudio.format
        ? voiceStreamStartFor(value.version)
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
 * Parse a service text message, accepting only the exact shapes of the stream's `version`, 1 unless
 * given: ready must carry it, and partials exist only in version 2. Ready limits above the product's
 * own are refused, so a service can never raise them. Partial and final text is accepted up to
 * `maxText` characters; `maxBytes` bounds the message as received.
 */
export function parseVoiceServiceMessage(
  text: string,
  {
    maxText,
    maxBytes,
    version = voiceStreamVersion,
  }: {
    readonly maxText: number;
    readonly maxBytes: number;
    readonly version?: VoiceStreamVersion;
  },
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
        value.version === version &&
        isCount(value.maxSamples, limits.maxSamples) &&
        (value.maxSamples as number) > 0 &&
        isCount(value.maxFrameSamples, limits.maxFrameSamples) &&
        (value.maxFrameSamples as number) > 0 &&
        isCount(value.windowSamples, limits.windowSamples) &&
        (value.windowSamples as number) > 0
        ? {
            type: "ready",
            version,
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
    case "partial":
      // At most one partial per audio message, so revisions never pass the message limit.
      return version >= voiceStreamLiveVersion &&
        hasExactKeys(value, ["type", "revision", "text"]) &&
        isCount(value.revision, limits.maxMessages) &&
        (value.revision as number) > 0 &&
        typeof value.text === "string" &&
        value.text.length <= maxText
        ? { type: "partial", revision: value.revision, text: value.text }
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
