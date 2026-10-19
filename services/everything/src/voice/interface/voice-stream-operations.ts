import type { VoiceStreamVersion } from "@everything/conversation-contracts/voice-stream";
import type { StreamChannel } from "./speech-streams.js";

/** The places an admitted stream holds until the speech service has finished with it. */
export interface VoiceStreamLease {
  /** Give the places back; calling it again has no effect. */
  release(): void;
}

/** Events a running stream takes from the browser's connection. */
export interface VoiceStreamEvents {
  fromBrowser(data: Uint8Array, binary: boolean): void;
  browserClosed(): void;
}

/** Streaming voice input use cases, independent of the WebSocket server. */
export interface VoiceStreamOperations {
  /** Whether a streaming speech service is configured. */
  readonly available: boolean;
  /** Check teammate ownership and take the stream's places, before the connection is upgraded. */
  admit(ownerId: string, agentId: string): Promise<VoiceStreamLease>;
  /** Run an admitted stream over the browser's connection, in the protocol version it agreed. */
  open(
    lease: VoiceStreamLease,
    browser: StreamChannel,
    version: VoiceStreamVersion,
  ): VoiceStreamEvents;
}
