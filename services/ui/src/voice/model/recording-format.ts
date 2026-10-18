/**
 * Recorder formats in order of preference. Chromium and Firefox record Opus in WebM or Ogg; Safari
 * records AAC in MP4. Only the browser's own `isTypeSupported` decides which is used.
 */
const preferredTypes = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
] as const;

/** The media type without parameters, in lower case. */
export function baseMediaType(type: string): string {
  return type.split(";")[0]!.trim().toLowerCase();
}

/**
 * The first preferred format that both this browser records and the server accepts, or null when
 * there is none.
 */
export function recordingType(
  isTypeSupported: (type: string) => boolean,
  accepted: readonly string[],
): string | null {
  for (const type of preferredTypes)
    if (accepted.includes(baseMediaType(type)) && isTypeSupported(type))
      return type;
  return null;
}

/**
 * The content type to upload: the recorder's own report when it names an accepted format, which can
 * differ from the requested type, otherwise the requested type.
 */
export function uploadType(
  recorderType: string,
  requested: string,
  accepted: readonly string[],
): string | null {
  if (recorderType)
    return accepted.includes(baseMediaType(recorderType)) ? recorderType : null;
  return requested;
}
