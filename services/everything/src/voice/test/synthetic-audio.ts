import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Whether FFmpeg is installed; decoder tests need the real decoder. */
export const ffmpegMissing =
  spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" })
    .status !== 0 && "FFmpeg isn't installed; install it to run decoder tests.";

/** Generated audio: a tone, or digital silence. */
export interface SyntheticAudio {
  readonly seconds: number;
  readonly silent?: boolean;
}

/** Container and codec arguments for each browser recording format. */
const encodings = {
  webm: ["-c:a", "libopus", "-b:a", "24k", "-f", "webm"],
  ogg: ["-c:a", "libopus", "-b:a", "24k", "-f", "ogg"],
  // Fragmented MP4 is the only MP4 FFmpeg can write to a pipe.
  mp4: [
    "-c:a",
    "aac",
    "-b:a",
    "48k",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
  ],
} as const;

/** Encode a generated signal, written to stdout so no file is involved. */
export function syntheticRecording(
  format: keyof typeof encodings,
  audio: SyntheticAudio,
): Buffer {
  return encode([...source(audio), ...encodings[format], "pipe:1"]);
}

/**
 * Encode AAC in MP4 with the movie box after the media data, FFmpeg's default layout, which needs a
 * seekable output; the temporary file holds only the generated signal.
 */
export function movieLastMp4(audio: SyntheticAudio): Buffer {
  const directory = mkdtempSync(join(tmpdir(), "voice-fixture-"));
  try {
    const path = join(directory, "tone.mp4");
    encode([
      ...source(audio),
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "mp4",
      path,
    ]);
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Encode generated audio into a container with an arbitrary codec, for rejection tests. */
export function syntheticContainer(
  codecArguments: readonly string[],
  audio: SyntheticAudio,
): Buffer {
  return encode([...source(audio), ...codecArguments, "pipe:1"]);
}

/** A 440 Hz tone or silence at 48 kHz, the rate browsers record at. */
function source({ seconds, silent }: SyntheticAudio): string[] {
  return [
    "-f",
    "lavfi",
    "-i",
    silent
      ? `anullsrc=r=48000:cl=mono:d=${seconds}`
      : `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
  ];
}

/** Run FFmpeg and return its stdout, failing the test if it fails. */
function encode(arguments_: string[]): Buffer {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...arguments_],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error("FFmpeg couldn't encode a fixture");
  return result.stdout;
}
