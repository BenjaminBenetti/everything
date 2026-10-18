import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VoiceFormatError,
  VoiceRecordingInvalidError,
} from "../error/voice-errors.js";
import { audioFormat } from "../model/audio-format.js";
import { movieBoxFirst } from "../model/mp4-layout.js";
import { isSilent, maxPcmBytes, waveFile } from "../model/pcm-audio.js";

/** An ISO base media box with a 32-bit size. */
function box(type: string, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

/** A chunk offset table: version and flags, entry count, then 32- or 64-bit offsets. */
function offsets(type: "stco" | "co64", values: number[]): Buffer {
  const entrySize = type === "co64" ? 8 : 4;
  const content = Buffer.alloc(8 + values.length * entrySize);
  content.writeUInt32BE(values.length, 4);
  values.forEach((value, index) => {
    if (type === "co64")
      content.writeBigUInt64BE(BigInt(value), 8 + index * entrySize);
    else content.writeUInt32BE(value, 8 + index * entrySize);
  });
  return box(type, content);
}

/** Read every offset in a table found in a file. */
function readOffsets(file: Buffer, type: "stco" | "co64"): number[] {
  const start = file.indexOf(type, 0, "latin1") + 4;
  const count = file.readUInt32BE(start + 4);
  return Array.from({ length: count }, (_, index) =>
    type === "co64"
      ? Number(file.readBigUInt64BE(start + 8 + index * 8))
      : file.readUInt32BE(start + 8 + index * 4),
  );
}

test("accepts only allowlisted containers whose bytes carry the declared signature", () => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  const ogg = Buffer.from("OggS\0\x02\0\0");
  const mp4 = Buffer.from("\0\0\0\x18ftypM4A ");
  assert.equal(audioFormat("audio/webm;codecs=opus", webm).demuxer, "matroska");
  assert.equal(audioFormat(" Audio/WebM ", webm).mediaType, "audio/webm");
  assert.equal(audioFormat("audio/ogg; codecs=opus", ogg).demuxer, "ogg");
  assert.equal(audioFormat("audio/mp4", mp4).demuxer, "mov");
  assert.deepEqual(audioFormat("audio/mp4;codecs=mp4a.40.2", mp4).decoders, [
    "aac",
    "aac_fixed",
    "opus",
    "libopus",
  ]);
  for (const contentType of [
    undefined,
    "",
    "audio/wav",
    "audio/mpeg",
    "video/webm",
    "application/json",
    "multipart/form-data; boundary=x",
    "audio/webm-extra",
  ])
    assert.throws(() => audioFormat(contentType, webm), VoiceFormatError);
  // The declared container must match the bytes.
  assert.throws(() => audioFormat("audio/webm", ogg), VoiceFormatError);
  assert.throws(() => audioFormat("audio/mp4", webm), VoiceFormatError);
  assert.throws(
    () => audioFormat("audio/ogg", Buffer.from("#EXTM3U\nhttp://x/a.ts\n")),
    VoiceFormatError,
  );
  assert.throws(
    () => audioFormat("audio/webm", Buffer.alloc(0)),
    VoiceRecordingInvalidError,
  );
  assert.throws(
    () => audioFormat("audio/webm", webm.subarray(0, 7)),
    VoiceRecordingInvalidError,
  );
});

test("moves the movie box ahead of the media data and shifts only offsets into it", () => {
  const fileType = box("ftyp", Buffer.from("isom\0\0\0\0"));
  const media = box("mdat", Buffer.from("SAMPLES-ONE|SAMPLES-TWO"));
  const mediaStart = fileType.length;
  const firstSample = mediaStart + 8;
  const secondSample = firstSample + 12;
  const movie = box(
    "moov",
    box(
      "trak",
      box(
        "mdia",
        box(
          "minf",
          box(
            "stbl",
            offsets("stco", [firstSample, secondSample]),
            offsets("co64", [secondSample]),
          ),
        ),
      ),
    ),
    box("udta", Buffer.from("stco not a table here")),
  );
  const file = Buffer.concat([fileType, media, movie]);
  const moved = movieBoxFirst(file);
  assert.equal(moved.length, file.length);
  assert.equal(
    moved.toString("latin1", mediaStart + 4, mediaStart + 8),
    "moov",
  );
  assert.deepEqual(readOffsets(moved, "stco"), [
    firstSample + movie.length,
    secondSample + movie.length,
  ]);
  assert.deepEqual(readOffsets(moved, "co64"), [secondSample + movie.length]);
  const shifted = readOffsets(moved, "stco")[0]!;
  assert.equal(moved.toString("latin1", shifted, shifted + 11), "SAMPLES-ONE");
  // The original is left untouched.
  assert.deepEqual(readOffsets(file, "stco"), [firstSample, secondSample]);
});

test("leaves movie-first and fragmented files unchanged", () => {
  const file = Buffer.concat([
    box("ftyp", Buffer.from("isom")),
    box("moov", box("mvex")),
    box("moof", Buffer.alloc(8)),
    box("mdat", Buffer.alloc(16)),
  ]);
  assert.equal(movieBoxFirst(file), file);
});

test("rejects box sizes and offset tables that overrun their parent", () => {
  const fileType = box("ftyp", Buffer.from("isom"));
  const oversized = Buffer.from(fileType);
  oversized.writeUInt32BE(1000, 0);
  assert.throws(() => movieBoxFirst(oversized), VoiceRecordingInvalidError);
  const tooSmall = Buffer.from(fileType);
  tooSmall.writeUInt32BE(4, 0);
  assert.throws(() => movieBoxFirst(tooSmall), VoiceRecordingInvalidError);
  const table = offsets("stco", [1]);
  table.writeUInt32BE(1_000_000, 12);
  assert.throws(
    () =>
      movieBoxFirst(
        Buffer.concat([
          fileType,
          box("mdat", Buffer.alloc(4)),
          box(
            "moov",
            box("trak", box("mdia", box("minf", box("stbl", table)))),
          ),
        ]),
      ),
    VoiceRecordingInvalidError,
  );
  assert.throws(
    () => movieBoxFirst(Buffer.concat([fileType, Buffer.from([0, 0, 0])])),
    VoiceRecordingInvalidError,
  );
});

/** Boxes of one type nested `depth` deep, built without repeated copying. */
function nested(type: string, depth: number): Buffer {
  const file = Buffer.alloc(8 * depth);
  for (let level = 0; level < depth; level++) {
    file.writeUInt32BE(8 * (depth - level), 8 * level);
    file.write(type, 8 * level + 4, "latin1");
  }
  return file;
}

test("bounds nesting and box counts so crafted files are rejected quickly rather than exhausting the stack", () => {
  const fileType = box("ftyp", Buffer.from("isom"));
  const media = box("mdat", Buffer.alloc(16));
  const started = performance.now();
  // Containers nested inside themselves are off the fixed path and never descended into.
  for (const type of ["moov", "trak", "mdia", "minf", "stbl"]) {
    const deep = nested(type, 50_000);
    const file = Buffer.concat([
      fileType,
      media,
      box("moov", box("trak", box("mdia", box("minf", box("stbl", deep))))),
    ]);
    assert.equal(movieBoxFirst(file).length, file.length);
  }
  // A movie box made of nothing but deep nesting along the path's first step.
  const deepMovie = Buffer.concat([fileType, media, nested("moov", 100_000)]);
  assert.equal(movieBoxFirst(deepMovie).length, deepMovie.length);
  // Too many tiny boxes, at the top level or inside the movie box.
  const tiny = Buffer.alloc(8 * 70_000);
  for (let index = 0; index < 70_000; index++) {
    tiny.writeUInt32BE(8, index * 8);
    tiny.write("free", index * 8 + 4, "latin1");
  }
  assert.throws(
    () => movieBoxFirst(Buffer.concat([fileType, media, tiny, box("moov")])),
    VoiceRecordingInvalidError,
  );
  assert.throws(
    () => movieBoxFirst(Buffer.concat([fileType, media, box("moov", tiny)])),
    VoiceRecordingInvalidError,
  );
  assert.throws(
    () =>
      movieBoxFirst(
        Buffer.concat([
          fileType,
          media,
          box("moov", box("trak", box("mdia", box("minf", box("stbl", tiny))))),
        ]),
      ),
    VoiceRecordingInvalidError,
  );
  assert.ok(performance.now() - started < 2_000);
});

test("wraps PCM in a 16 kHz mono 16-bit WAVE header and detects silence", () => {
  const pcm = Buffer.alloc(32);
  const wave = waveFile(pcm);
  assert.equal(wave.length, 44 + pcm.length);
  assert.equal(wave.toString("latin1", 0, 4), "RIFF");
  assert.equal(wave.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wave.toString("latin1", 8, 16), "WAVEfmt ");
  assert.equal(wave.readUInt16LE(20), 1);
  assert.equal(wave.readUInt16LE(22), 1);
  assert.equal(wave.readUInt32LE(24), 16_000);
  assert.equal(wave.readUInt32LE(28), 32_000);
  assert.equal(wave.readUInt16LE(32), 2);
  assert.equal(wave.readUInt16LE(34), 16);
  assert.equal(wave.toString("latin1", 36, 40), "data");
  assert.equal(wave.readUInt32LE(40), pcm.length);
  assert.equal(isSilent(pcm), true);
  pcm.writeInt16LE(-32, 4);
  assert.equal(isSilent(pcm), true);
  pcm.writeInt16LE(-33, 6);
  assert.equal(isSilent(pcm), false);
  assert.equal(maxPcmBytes, 60 * 16_000 * 2);
});
