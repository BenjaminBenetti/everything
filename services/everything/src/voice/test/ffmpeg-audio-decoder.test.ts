import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  FfmpegAudioDecoder,
  defaultDecoderBudget,
} from "../adapter/ffmpeg-audio-decoder.js";
import {
  VoiceRecordingInvalidError,
  VoiceRecordingTooLongError,
  VoiceUnavailableError,
} from "../error/voice-errors.js";
import { audioFormat, type AudioFormat } from "../model/audio-format.js";
import { isSilent, maxPcmBytes, pcmFormat } from "../model/pcm-audio.js";
import {
  ffmpegMissing,
  movieLastMp4,
  syntheticContainer,
  syntheticRecording,
} from "./synthetic-audio.js";

const skip = ffmpegMissing;

/** Bytes of decoded PCM per second. */
const bytesPerSecond = pcmFormat.sampleRate * pcmFormat.bytesPerSample;

/** Formats as the service validates them from the browser's content type. */
const webm = audioFormat(
  "audio/webm;codecs=opus",
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
);
const ogg = audioFormat("audio/ogg", Buffer.from("OggS\0\0\0\0"));
const mp4 = audioFormat("audio/mp4", Buffer.from("\0\0\0\x18ftypisom"));

/** Decode with a fresh decoder and a signal that is never aborted. */
function decode(format: AudioFormat, bytes: Buffer): Promise<Buffer> {
  return new FfmpegAudioDecoder().decode(
    { format, bytes },
    new AbortController().signal,
  );
}

/** A directory for fake executables and referenced files, removed after the test. */
function scratch(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "voice-decoder-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Write an executable shell script standing in for FFmpeg. */
function fakeFfmpeg(directory: string, script: string): string {
  const path = join(directory, "fake-ffmpeg");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

test(
  "decodes each browser container to 16 kHz mono PCM of the recording's length",
  { skip },
  async () => {
    for (const [format, bytes] of [
      [webm, syntheticRecording("webm", { seconds: 2 })],
      [ogg, syntheticRecording("ogg", { seconds: 2 })],
      [mp4, syntheticRecording("mp4", { seconds: 2 })],
    ] as const) {
      const pcm = await decode(format, bytes);
      // Encoder priming can add a few milliseconds.
      assert.ok(
        Math.abs(pcm.length - 2 * bytesPerSecond) < bytesPerSecond / 10,
        `${format.mediaType}: ${pcm.length}`,
      );
      assert.equal(isSilent(pcm), false);
    }
  },
);

test(
  "decodes MP4 whose movie box follows its media data without a seekable input or temporary file",
  { skip },
  async () => {
    const bytes = movieLastMp4({ seconds: 30 });
    assert.ok(
      bytes.indexOf("moov", 0, "latin1") > bytes.indexOf("mdat", 0, "latin1"),
    );
    const pcm = await decode(mp4, bytes);
    assert.ok(Math.abs(pcm.length - 30 * bytesPerSecond) < bytesPerSecond / 10);
  },
);

test(
  "accepts audio just under the limit and rejects audio over it by counting decoded frames",
  { skip },
  async () => {
    const underLimit = await decode(
      webm,
      syntheticRecording("webm", { seconds: 59.5 }),
    );
    assert.ok(underLimit.length <= maxPcmBytes);
    // WebM written to a pipe carries no duration, so only decoded frames can reveal the length.
    for (const [format, bytes] of [
      [webm, syntheticRecording("webm", { seconds: 61 })],
      [ogg, syntheticRecording("ogg", { seconds: 90 })],
      [mp4, syntheticRecording("mp4", { seconds: 61 })],
      [mp4, movieLastMp4({ seconds: 61 })],
    ] as const)
      await assert.rejects(decode(format, bytes), VoiceRecordingTooLongError);
  },
);

test("decodes silence as silence", { skip }, async () => {
  const pcm = await decode(
    ogg,
    syntheticRecording("ogg", { seconds: 1, silent: true }),
  );
  assert.ok(pcm.length > 0);
  assert.equal(isSilent(pcm), true);
});

test(
  "rejects malformed, truncated, video-only, and non-allowlisted codec input",
  { skip },
  async () => {
    const recording = syntheticRecording("webm", { seconds: 2 });
    const garbage = Buffer.alloc(4096, 0x5a);
    recording.copy(garbage, 0, 0, 4);
    // Headers without a single cluster of frames; frames before a later cut would still decode.
    const headersOnly = recording.subarray(
      0,
      recording.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75])),
    );
    const truncatedMp4 = movieLastMp4({ seconds: 2 }).subarray(0, 2048);
    for (const [format, bytes] of [
      [webm, garbage],
      [webm, headersOnly],
      [mp4, truncatedMp4],
      [
        webm,
        syntheticContainer(["-c:a", "pcm_s16le", "-f", "matroska"], {
          seconds: 1,
        }),
      ],
      [ogg, syntheticContainer(["-c:a", "flac", "-f", "ogg"], { seconds: 1 })],
      [
        mp4,
        syntheticContainer(
          [
            "-c:a",
            "alac",
            "-movflags",
            "frag_keyframe+empty_moov",
            "-f",
            "mp4",
          ],
          { seconds: 1 },
        ),
      ],
    ] as const)
      await assert.rejects(decode(format, bytes), VoiceRecordingInvalidError);
  },
);

test(
  "never follows playlists, network URLs, or references to other files",
  { skip },
  async (context) => {
    const directory = scratch(context);
    const tone = syntheticRecording("webm", { seconds: 2 });
    const localFile = join(directory, "tone.webm");
    writeFileSync(localFile, tone);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end(tone);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    context.after(() => server.close());
    const remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tone.webm`;
    // Each playlist names playable audio; decoding any of it would succeed.
    const playlists = [
      `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n${remote}\n#EXTINF:2.0,\n${localFile}\n#EXT-X-ENDLIST\n`,
      `ffconcat version 1.0\nfile '${localFile}'\nfile '${remote}'\n`,
      `[playlist]\nFile1=${remote}\nFile2=file:${localFile}\nNumberOfEntries=2\n`,
      `v=0\no=- 0 0 IN IP4 127.0.0.1\ns=x\nc=IN IP4 127.0.0.1\nt=0 0\nm=audio 9 RTP/AVP 0\n`,
      `${remote}\nfile:${localFile}\nsubfile,,start,0,end,0,,:${localFile}\n`,
    ];
    for (const playlist of playlists)
      for (const format of [webm, ogg, mp4])
        await assert.rejects(
          decode(format, Buffer.from(playlist)),
          VoiceRecordingInvalidError,
        );
    assert.equal(requests, 0);
  },
);

test("applies kernel limits and passes only PATH to the decoder", async (context) => {
  const directory = scratch(context);
  process.env.VOICE_DECODER_TEST_SECRET = "must-not-leak";
  context.after(() => delete process.env.VOICE_DECODER_TEST_SECRET);
  const limits = await new FfmpegAudioDecoder({
    ffmpeg: fakeFfmpeg(directory, "cat /proc/self/limits; env"),
    prlimit: "prlimit",
  }).decode(
    { format: webm, bytes: Buffer.alloc(16) },
    new AbortController().signal,
  );
  const report = limits.toString("utf8");
  assert.match(
    report,
    new RegExp(`Max cpu time\\s+${defaultDecoderBudget.cpuSeconds}\\s`),
  );
  assert.match(
    report,
    new RegExp(
      `Max address space\\s+${defaultDecoderBudget.addressSpaceBytes}\\s`,
    ),
  );
  assert.match(report, /Max file size\s+0\s/);
  assert.match(report, /Max core file size\s+0\s/);
  assert.doesNotMatch(report, /VOICE_DECODER_TEST_SECRET|must-not-leak/);
  assert.match(report, /^PATH=/m);
});

test("kills the decoder when the caller aborts or the time budget runs out", async (context) => {
  const directory = scratch(context);
  // exec keeps the fake's PID, as prlimit does for FFmpeg.
  const ffmpeg = fakeFfmpeg(directory, "exec sleep 30");
  const abort = new AbortController();
  const started = Date.now();
  const aborted = new FfmpegAudioDecoder({ ffmpeg, prlimit: "prlimit" }).decode(
    { format: webm, bytes: Buffer.alloc(16) },
    abort.signal,
  );
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(aborted, VoiceUnavailableError);
  const timedOut = new FfmpegAudioDecoder(
    { ffmpeg, prlimit: "prlimit" },
    { ...defaultDecoderBudget, timeoutMs: 100 },
  ).decode(
    { format: webm, bytes: Buffer.alloc(16) },
    new AbortController().signal,
  );
  await assert.rejects(timedOut, VoiceRecordingInvalidError);
  assert.ok(Date.now() - started < 5_000);
  await assert.rejects(
    new FfmpegAudioDecoder({ ffmpeg, prlimit: "prlimit" }).decode(
      { format: webm, bytes: Buffer.alloc(16) },
      AbortSignal.abort(),
    ),
    VoiceUnavailableError,
  );
});

test("stops a decoder that produces more than the limit without buffering it", async (context) => {
  const directory = scratch(context);
  const ffmpeg = fakeFfmpeg(directory, "exec cat /dev/zero");
  await assert.rejects(
    new FfmpegAudioDecoder({ ffmpeg, prlimit: "prlimit" }).decode(
      { format: webm, bytes: Buffer.alloc(16) },
      new AbortController().signal,
    ),
    VoiceRecordingTooLongError,
  );
});

test("reports whether the decoder can start", { skip }, async (context) => {
  assert.equal(await new FfmpegAudioDecoder().verify(), true);
  const missing = join(scratch(context), "missing-ffmpeg");
  assert.equal(
    await new FfmpegAudioDecoder({
      ffmpeg: missing,
      prlimit: "prlimit",
    }).verify(),
    false,
  );
  await assert.rejects(
    new FfmpegAudioDecoder({ ffmpeg: "ffmpeg", prlimit: missing }).decode(
      { format: webm, bytes: Buffer.alloc(16) },
      new AbortController().signal,
    ),
    VoiceUnavailableError,
  );
});
