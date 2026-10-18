/** The operator's self-hosted speech recognition endpoint, configured only at deployment. */
export interface SpeechServiceSettings {
  /** Complete transcription endpoint URL, for example an in-cluster OpenAI-compatible server. */
  readonly url: string;
  /** Bearer token for the service; empty sends none. */
  readonly token: string;
  /** Model identifier sent with each request; empty sends none. */
  readonly model: string;
  /** Deadline for one transcription by the service. */
  readonly timeoutMs: number;
}

/** How many transcriptions run at once and how many may wait, across all callers. */
export interface VoiceAdmissionSettings {
  readonly concurrency: number;
  readonly queueLimit: number;
  /** Longest a transcription may wait for a free slot. */
  readonly queueTimeoutMs: number;
}

/** The operator's self-hosted streaming speech service, configured only at deployment. */
export interface SpeechStreamSettings {
  /** WebSocket URL of the service's stream endpoint, for example `ws://voice-asr:8080/v1/stream`. */
  readonly url: string;
  /** Bearer token for the service; empty sends none. */
  readonly token: string;
  /** Longest to wait for a stream's final transcript after its end. */
  readonly finalTimeoutMs: number;
  /** Streams that may run at once across all owners. */
  readonly concurrency: number;
}

/**
 * Voice input configuration. Each lane is unavailable without its service: `service` transcribes
 * uploaded recordings, `stream` transcribes audio streamed while the microphone is held.
 */
export interface VoiceSettings {
  readonly service: SpeechServiceSettings | null;
  readonly stream: SpeechStreamSettings | null;
  readonly admission: VoiceAdmissionSettings;
}
