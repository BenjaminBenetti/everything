import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baseMediaType,
  recordingType,
  uploadType,
} from "../model/recording-format.js";

const accepted = ["audio/webm", "audio/ogg", "audio/mp4"];

/** A browser that records exactly these types. */
const browser =
  (...types: string[]) =>
  (type: string) =>
    types.includes(type);

test("chooses Opus in WebM for Chromium, Ogg for Firefox builds without WebM, and AAC in MP4 for Safari", () => {
  assert.equal(
    recordingType(
      browser("audio/webm;codecs=opus", "audio/webm", "audio/mp4"),
      accepted,
    ),
    "audio/webm;codecs=opus",
  );
  assert.equal(
    recordingType(browser("audio/ogg;codecs=opus", "audio/ogg"), accepted),
    "audio/ogg;codecs=opus",
  );
  assert.equal(
    recordingType(browser("audio/mp4;codecs=mp4a.40.2", "audio/mp4"), accepted),
    "audio/mp4;codecs=mp4a.40.2",
  );
  assert.equal(recordingType(browser("audio/mp4"), accepted), "audio/mp4");
});

test("records nothing the browser can't produce or the server won't accept", () => {
  assert.equal(
    recordingType(browser("audio/wav", "audio/mpeg"), accepted),
    null,
  );
  assert.equal(
    recordingType(browser("audio/webm;codecs=opus"), ["audio/mp4"]),
    null,
  );
  assert.equal(
    recordingType(() => false, accepted),
    null,
  );
});

test("uploads with the recorder's actual type when it is accepted", () => {
  assert.equal(baseMediaType(" Audio/MP4; codecs=mp4a.40.2"), "audio/mp4");
  assert.equal(
    uploadType("audio/mp4", "audio/mp4;codecs=mp4a.40.2", accepted),
    "audio/mp4",
  );
  assert.equal(
    uploadType("", "audio/webm;codecs=opus", accepted),
    "audio/webm;codecs=opus",
  );
  assert.equal(
    uploadType("video/x-matroska;codecs=avc1", "audio/webm", accepted),
    null,
  );
});
