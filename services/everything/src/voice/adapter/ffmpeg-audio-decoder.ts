import { spawn } from "node:child_process";
import { ApplicationError } from "@everything/errors";
import {
  VoiceRecordingInvalidError,
  VoiceRecordingTooLongError,
  VoiceUnavailableError,
} from "../error/voice-errors.js";
import type { AudioDecoder, EncodedAudio } from "../interface/audio-decoder.js";
import type { AudioFormat } from "../model/audio-format.js";
import { movieBoxFirst } from "../model/mp4-layout.js";
import { maxPcmBytes, pcmFormat } from "../model/pcm-audio.js";

/** Resources one decoder process may use, enforced by the decoder's timer and the kernel. */
export interface DecoderBudget {
  /** Wall-clock time before the decoder is killed. */
  readonly timeoutMs: number;
  /** CPU time the kernel allows the decoder before stopping it. */
  readonly cpuSeconds: number;
  /** Address space the kernel allows the decoder, in bytes. */
  readonly addressSpaceBytes: number;
  /** Largest single allocation FFmpeg may make, in bytes. */
  readonly maxAllocationBytes: number;
}

/** Defaults for one recording of at most the duration limit; not yet measured on target hardware. */
export const defaultDecoderBudget: DecoderBudget = {
  timeoutMs: 15_000,
  cpuSeconds: 30,
  addressSpaceBytes: 1024 * 1024 * 1024,
  maxAllocationBytes: 128 * 1024 * 1024,
};

/** Executables the decoder runs: FFmpeg, started through util-linux `prlimit` for kernel limits. */
export interface DecoderExecutables {
  readonly ffmpeg: string;
  readonly prlimit: string;
}

/** How long the startup check waits for the decoder to report its version. */
const verifyTimeoutMs = 5_000;

/**
 * Decodes recordings with an FFmpeg subprocess that reads only the uploaded bytes on stdin and writes
 * PCM to stdout. The container's demuxer and decoders are fixed by its validated format and only the
 * pipe protocol is allowed, so playlists, network URLs, and other files are never opened. Codec and
 * filter threads are limited to one, and kernel limits cap its CPU time and address space and forbid
 * writing files. Decoded frames are counted as they arrive, and the decoder is killed as soon as they
 * pass the duration limit, so a long recording is rejected rather than shortened. Stderr is discarded
 * unread, because diagnostics can describe the recording.
 */
export class FfmpegAudioDecoder implements AudioDecoder {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the executables on PATH unless others are given. */
  constructor(
    private readonly executables: DecoderExecutables = {
      ffmpeg: "ffmpeg",
      prlimit: "prlimit",
    },
    private readonly budget: DecoderBudget = defaultDecoderBudget,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Confirm the decoder starts, so voice input is only offered when recordings can be decoded. */
  verify(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(
        this.executables.prlimit,
        this.limited(["-hide_banner", "-loglevel", "error", "-version"]),
        { stdio: "ignore", env: decoderEnvironment() },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), verifyTimeoutMs);
      child.once("error", () => undefined);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }

  /** Decode one recording to PCM, rejecting unreadable input and audio longer than the limit. */
  decode(audio: EncodedAudio, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) return Promise.reject(new VoiceUnavailableError());
    let input: Buffer;
    try {
      input =
        audio.format.demuxer === "mov"
          ? movieBoxFirst(audio.bytes)
          : audio.bytes;
    } catch (error) {
      return Promise.reject(
        error instanceof ApplicationError
          ? error
          : new VoiceRecordingInvalidError(),
      );
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.executables.prlimit,
        this.limited(this.arguments(audio.format)),
        { stdio: ["pipe", "pipe", "ignore"], env: decoderEnvironment() },
      );
      let output: Buffer[] = [];
      let size = 0;
      let failure: Error | undefined;

      /** Record the first failure and stop the decoder; the close handler settles the promise. */
      const stop = (error: Error): void => {
        failure ??= error;
        output = [];
        child.kill("SIGKILL");
      };
      const onAbort = (): void => stop(new VoiceUnavailableError());
      const timer = setTimeout(
        () => stop(new VoiceRecordingInvalidError()),
        this.budget.timeoutMs,
      );
      signal.addEventListener("abort", onAbort, { once: true });

      // Count the actual decoded frames; container metadata about duration is never trusted.
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        size += chunk.length;
        if (size > maxPcmBytes) stop(new VoiceRecordingTooLongError());
        else output.push(chunk);
      });
      // The decoder may exit before reading all input, for example on malformed data.
      child.stdin.on("error", () => undefined);
      child.once("error", () => {
        failure ??= new VoiceUnavailableError();
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const pcm = output;
        output = [];
        if (failure) reject(failure);
        // FFmpeg can exit successfully without output when the container has no decodable audio.
        else if (code !== 0 || size === 0)
          reject(new VoiceRecordingInvalidError());
        else resolve(Buffer.concat(pcm, size));
      });
      child.stdin.end(input);
    });
  }

  // ===========================================
  // Decoder invocation
  // ===========================================

  /** Run FFmpeg under kernel limits: CPU time, address space, no file writes, and no core dumps. */
  private limited(ffmpegArguments: string[]): string[] {
    return [
      `--cpu=${this.budget.cpuSeconds}`,
      `--as=${this.budget.addressSpaceBytes}`,
      "--fsize=0",
      "--core=0",
      "--",
      this.executables.ffmpeg,
      ...ffmpegArguments,
    ];
  }

  /** Fixed arguments for one validated format; no value comes from the request. */
  private arguments(format: AudioFormat): string[] {
    return [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "error",
      // Treat demuxing and decoding errors as failures instead of returning partial audio.
      "-xerror",
      "-max_alloc",
      String(this.budget.maxAllocationBytes),
      "-filter_threads",
      "1",
      "-threads",
      "1",
      "-protocol_whitelist",
      "pipe",
      "-f",
      format.demuxer,
      "-codec_whitelist",
      format.decoders.join(","),
      "-i",
      "pipe:0",
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      String(pcmFormat.channels),
      "-ar",
      String(pcmFormat.sampleRate),
      "-threads",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ];
  }
}

/** Only PATH reaches the decoder; the service's credentials stay out of its environment. */
function decoderEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin" };
}
