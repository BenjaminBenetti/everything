import type { AudioFormat } from "../model/audio-format.js";

/** Recording bytes whose container format has already been validated. */
export interface EncodedAudio {
  readonly format: AudioFormat;
  readonly bytes: Buffer;
}

/** Decodes recordings to 16 kHz mono 16-bit PCM, enforcing the decoded-duration limit. */
export interface AudioDecoder {
  /** Decode one recording, or reject it as unreadable or too long. */
  decode(audio: EncodedAudio, signal: AbortSignal): Promise<Buffer>;
}
