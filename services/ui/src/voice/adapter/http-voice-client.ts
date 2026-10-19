import type {
  VoiceCapabilities,
  VoiceTranscript,
} from "@everything/conversation-contracts/voice";
import type { BinaryTransport } from "../../http/interface/binary-transport.js";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import { HttpRequestError } from "../../http/model/http-request-error.js";
import type { RecordedAudio, VoiceClient } from "../interface/voice-client.js";
import { VoiceInputError } from "../model/voice-input-error.js";
import { noticeForStatus } from "../model/voice-notice.js";

/** Map voice input to the authenticated API; recordings go to the teammate-scoped route. */
export class HttpVoiceClient implements VoiceClient {
  // ===========================================
  // Construction
  // ===========================================

  /** Share the application's cookie and error handling policy. */
  constructor(private readonly transport: JsonTransport & BinaryTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read whether voice input is available and its limits. */
  capabilities(signal?: AbortSignal): Promise<VoiceCapabilities> {
    return this.transport.request(
      "/v1/voice/capabilities",
      signal ? { signal } : {},
    );
  }

  /** Upload one finished recording once; a failed upload is never retried. */
  async transcribe(
    agentId: string,
    audio: RecordedAudio,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const transcript = await this.transport.upload<VoiceTranscript>(
        `/v1/agents/${encodeURIComponent(agentId)}/voice/transcriptions`,
        audio.blob,
        audio.type,
        signal,
      );
      return transcript.text;
    } catch (error) {
      throw new VoiceInputError(
        error instanceof HttpRequestError
          ? noticeForStatus(error.status)
          : signal.aborted
            ? "timedOut"
            : "failed",
      );
    }
  }
}
