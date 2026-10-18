import type {
  MediaEnvironment,
  MediaRecorderLike,
} from "../interface/media-environment.js";

/** The browser's microphone and MediaRecorder; nothing is recorded until a dictation asks. */
export function browserMedia(): MediaEnvironment {
  const blocker = !window.isSecureContext
    ? "insecure"
    : !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ? "unsupported"
      : null;
  return {
    blocker,
    isTypeSupported: (type) => !blocker && MediaRecorder.isTypeSupported(type),
    getUserMedia: () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
    createRecorder: (stream, options) =>
      new MediaRecorder(
        stream as MediaStream,
        options,
      ) as unknown as MediaRecorderLike,
  };
}
