/** Outcomes of a dictation the composer reports in its status line. */
export type VoiceNotice =
  | "inserted"
  | "noSpeech"
  | "doesNotFit"
  | "tooShort"
  | "cancelled"
  | "limitReached"
  | "tooLarge"
  | "permissionDenied"
  | "noMicrophone"
  | "microphoneFailed"
  | "unsupported"
  | "needsSecureConnection"
  | "busy"
  | "unavailable"
  | "timedOut"
  | "teammateMissing"
  | "sessionExpired"
  | "failed";

/** Status text for each outcome; errors say what happened and what to do next. */
export const voiceNoticeText: Readonly<Record<VoiceNotice, string>> = {
  inserted: "Added your words to the message. Review them before sending.",
  noSpeech: "No speech was recognized, so nothing was added.",
  doesNotFit:
    "The transcript doesn't fit in this message. Shorten your draft, then record again.",
  tooShort: "Keep holding to record, then release to add your words.",
  cancelled: "Recording canceled. Nothing was added.",
  limitReached:
    "Recording stopped at the 1-minute limit. Transcribing what you said…",
  tooLarge: "That recording is too large to send. Try a shorter one.",
  permissionDenied:
    "Microphone access is blocked. Allow it in your browser's site settings to record.",
  noMicrophone: "No microphone was found. Connect one and try again.",
  microphoneFailed: "The microphone couldn't start. Try again.",
  unsupported: "This browser can't record audio for voice input.",
  needsSecureConnection:
    "Voice input needs a secure (HTTPS) connection to use the microphone.",
  busy: "Your previous recording is still being transcribed. Try again in a moment.",
  unavailable: "Voice input isn't available right now. Try again later.",
  timedOut: "Transcribing took too long. Try a shorter recording.",
  teammateMissing: "This teammate is no longer available.",
  sessionExpired: "Your session has expired. Sign out and sign in again.",
  failed: "Your recording couldn't be transcribed. Try again.",
};

/** Notices that report a problem, announced assertively. */
export const voiceProblems: ReadonlySet<VoiceNotice> = new Set([
  "doesNotFit",
  "tooLarge",
  "permissionDenied",
  "noMicrophone",
  "microphoneFailed",
  "unsupported",
  "needsSecureConnection",
  "busy",
  "unavailable",
  "timedOut",
  "teammateMissing",
  "sessionExpired",
  "failed",
]);

/** The outcome to report for a failed transcription request's HTTP status. */
export function noticeForStatus(status: number | undefined): VoiceNotice {
  switch (status) {
    case 401:
      return "sessionExpired";
    case 404:
      return "teammateMissing";
    case 413:
      return "tooLarge";
    case 429:
      return "busy";
    case 503:
      return "unavailable";
    case 504:
      return "timedOut";
    default:
      return "failed";
  }
}
