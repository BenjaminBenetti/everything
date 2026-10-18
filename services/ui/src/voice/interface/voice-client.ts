import type { VoiceCapabilities } from "@everything/conversation-contracts/voice";

/** One finished recording and the content type its recorder reported. */
export interface RecordedAudio {
  readonly blob: Blob;
  readonly type: string;
}

/** Voice input capabilities in the browser, independent of HTTP. */
export interface VoiceClient {
  /** Whether this installation transcribes recordings, and its limits. */
  capabilities(signal?: AbortSignal): Promise<VoiceCapabilities>;
  /** Transcribe a finished recording made for a teammate's message. */
  transcribe(
    agentId: string,
    audio: RecordedAudio,
    signal: AbortSignal,
  ): Promise<string>;
}
