import { VoiceUnavailableError } from "../error/voice-errors.js";
import type { SpeechRecognizer } from "../interface/speech-recognizer.js";

/** Stands in for the speech recognition service when none is configured. */
export class UnavailableSpeechRecognizer implements SpeechRecognizer {
  readonly available = false;

  /** Refuse every recording. */
  async transcribe(): Promise<never> {
    throw new VoiceUnavailableError();
  }
}
