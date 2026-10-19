import {
  voiceMediaTypes,
  type VoiceMediaType,
} from "@everything/conversation-contracts/voice";
import {
  VoiceFormatError,
  VoiceRecordingInvalidError,
} from "../error/voice-errors.js";

/** How the decoder reads one accepted container format. */
export interface AudioFormat {
  readonly mediaType: VoiceMediaType;
  /** FFmpeg demuxer forced for the container, so input is never probed as another format. */
  readonly demuxer: "matroska" | "ogg" | "mov";
  /** Audio decoders permitted inside the container. */
  readonly decoders: readonly string[];
}

/** Decoders for the codecs browsers record into each container, and each container's signature. */
const containers: Readonly<
  Record<
    VoiceMediaType,
    Omit<AudioFormat, "mediaType"> & { matches(bytes: Buffer): boolean }
  >
> = {
  "audio/webm": {
    demuxer: "matroska",
    decoders: ["opus", "libopus", "vorbis", "libvorbis"],
    /** EBML header magic. */
    matches: (bytes) => bytes.readUInt32BE(0) === 0x1a45dfa3,
  },
  "audio/ogg": {
    demuxer: "ogg",
    decoders: ["opus", "libopus", "vorbis", "libvorbis"],
    /** First Ogg page capture pattern. */
    matches: (bytes) => bytes.toString("latin1", 0, 4) === "OggS",
  },
  "audio/mp4": {
    demuxer: "mov",
    decoders: ["aac", "aac_fixed", "opus", "libopus"],
    /** A leading file type box. */
    matches: (bytes) => bytes.toString("latin1", 4, 8) === "ftyp",
  },
};

/** Smallest input that can hold any accepted container's signature. */
const signatureLength = 8;

/**
 * Accept only the allowlisted container named by the content type, and only when the bytes carry
 * that container's signature; parameters such as codecs are ignored.
 */
export function audioFormat(
  contentType: string | undefined,
  bytes: Buffer,
): AudioFormat {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  const accepted = voiceMediaTypes.find((type) => type === mediaType);
  if (!accepted) throw new VoiceFormatError();
  if (bytes.length < signatureLength) throw new VoiceRecordingInvalidError();
  const { matches, ...format } = containers[accepted];
  if (!matches(bytes)) throw new VoiceFormatError();
  return { mediaType: accepted, ...format };
}
