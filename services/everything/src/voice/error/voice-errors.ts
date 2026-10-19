import { ApplicationError } from "@everything/errors";
import { voiceLimits } from "@everything/conversation-contracts/voice";

/** No speech recognition service is configured, or it cannot be used right now. */
export class VoiceUnavailableError extends ApplicationError {
  /** Explain that recordings can't be transcribed at the moment. */
  constructor() {
    super(
      503,
      "VOICE_UNAVAILABLE",
      "Voice input isn't available right now. Try again later.",
    );
  }
}

/** The caller already has a recording being transcribed. */
export class VoiceBusyError extends ApplicationError {
  /** Ask the caller to wait for the earlier recording. */
  constructor() {
    super(
      429,
      "VOICE_BUSY",
      "Your previous recording is still being transcribed. Wait for it to finish.",
    );
  }
}

/** Every transcription slot and queue place is taken, or the wait for one ran out. */
export class VoiceCapacityError extends ApplicationError {
  /** Ask the caller to try again shortly. */
  constructor() {
    super(503, "VOICE_CAPACITY", "Voice input is busy. Try again in a moment.");
  }
}

/** The request's content type is not a supported recording format. */
export class VoiceFormatError extends ApplicationError {
  /** Name the formats that are accepted. */
  constructor() {
    super(
      415,
      "VOICE_UNSUPPORTED_FORMAT",
      "Recordings must be WebM, Ogg, or MP4 audio.",
    );
  }
}

/** The recording is empty, malformed, or doesn't contain a decodable audio stream. */
export class VoiceRecordingInvalidError extends ApplicationError {
  /** Ask the caller to record again. */
  constructor() {
    super(
      400,
      "VOICE_RECORDING_INVALID",
      "The recording couldn't be read. Try recording again.",
    );
  }
}

/** The recording's decoded audio is longer than the transcription limit. */
export class VoiceRecordingTooLongError extends ApplicationError {
  /** State the limit. */
  constructor() {
    super(
      413,
      "VOICE_RECORDING_TOO_LONG",
      `Recordings can be up to ${voiceLimits.maxDurationMs / 1000} seconds long.`,
    );
  }
}

/** The speech recognition service didn't finish within its deadline. */
export class VoiceTimeoutError extends ApplicationError {
  /** Suggest a shorter recording. */
  constructor() {
    super(
      504,
      "VOICE_TIMEOUT",
      "Transcribing took too long. Try a shorter recording.",
    );
  }
}

/** The speech recognition service failed or returned something other than a transcript. */
export class VoiceTranscriptionFailedError extends ApplicationError {
  /** Ask the caller to try again. */
  constructor() {
    super(
      502,
      "VOICE_TRANSCRIPTION_FAILED",
      "Your recording couldn't be transcribed. Try again.",
    );
  }
}
