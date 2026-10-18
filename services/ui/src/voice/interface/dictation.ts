import type { VoiceInputError } from "../model/voice-input-error.js";

/**
 * One dictation from microphone to transcript, whichever lane carries it. Gestures, the draft
 * anchor, and cancellation are handled the same way for every lane.
 */
export interface Dictation {
  /** Request the microphone and start; true once recording, false if finished or cancelled first. */
  start(): Promise<boolean>;
  /** Stop recording and resolve the final transcript, or null when nothing was recorded. */
  finish(): Promise<string | null>;
  /** Stop at once and drop everything; nothing is reported. */
  cancel(): void;
}

/** What a dictation reports while it runs. */
export interface DictationEvents {
  /** The duration limit was reached; the caller finishes the dictation. */
  onLimit(): void;
  /** The dictation failed while no finish was pending. */
  onFailure(error: VoiceInputError): void;
}
