import type { VoiceNotice } from "./voice-notice.js";

/** A dictation failure, carrying the outcome the composer reports. */
export class VoiceInputError extends Error {
  /** Name the outcome; the message is never shown, the notice's text is. */
  constructor(readonly notice: VoiceNotice) {
    super(notice);
    this.name = "VoiceInputError";
  }
}

/** The outcome to report for any failure. */
export function noticeOf(error: unknown): VoiceNotice {
  return error instanceof VoiceInputError ? error.notice : "failed";
}
