/** A self-hosted speech recognition service that turns one finished recording into text. */
export interface SpeechRecognizer {
  /** Whether a service is configured; when false, every transcription is refused. */
  readonly available: boolean;
  /** Transcribe a 16 kHz mono WAVE file to its final text. */
  transcribe(
    wave: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<string>;
}
