import type {
  VoiceCapabilities,
  VoiceTranscript,
} from "@everything/conversation-contracts/voice";

/** A recording as received from the caller, before its format is validated. */
export interface VoiceRecording {
  readonly contentType: string | undefined;
  readonly bytes: Buffer;
}

/** An owner's place for one recording, held from before its upload is read until its response ends. */
export interface VoiceReservation {
  readonly ownerId: string;
  /** Give the place up; calling it again has no effect. */
  release(): void;
}

/** Voice input use cases, independent of HTTP. */
export interface VoiceOperations {
  /** Whether recordings can be transcribed, and the limits that apply. */
  capabilities(): VoiceCapabilities;
  /**
   * Reserve the owner's one recording place before any of its upload is read, so uploads are bounded
   * per owner and in total; refuses when voice input is unavailable or busy.
   */
  reserve(ownerId: string): VoiceReservation;
  /** Transcribe a recording made for a teammate the reservation's owner owns. */
  transcribe(
    reservation: VoiceReservation,
    agentId: string,
    recording: VoiceRecording,
    signal: AbortSignal,
  ): Promise<VoiceTranscript>;
}
