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

/** Voice input configuration; without a service, voice input is unavailable. */
export interface VoiceSettings {
  readonly service: SpeechServiceSettings | null;
  readonly admission: VoiceAdmissionSettings;
}
