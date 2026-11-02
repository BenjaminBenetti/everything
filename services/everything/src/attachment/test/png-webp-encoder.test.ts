import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { deflateSync } from "node:zlib";
import { PngWebpEncoder } from "../adapter/png-webp-encoder.js";
import { staticPng } from "../model/static-png.js";
import {
  imageDimensions,
  imageMediaType,
} from "../../workspace/model/image-format.js";
import { screenshot, animatedPng, pngChunk } from "./synthetic-screenshot.js";

test("the real production encoder returns smaller valid WebP at identical resolution, with exact 8-bit alpha", async () => {
  const input = await screenshot();
  const output = await new PngWebpEncoder().webp(input);
  assert.ok(output, "The actual codec must run, not silently fall back");
  assert.ok(output.length < input.length);
  assert.equal(imageMediaType(output), "image/webp");
  assert.deepEqual(imageDimensions(output, "image/webp"), {
    width: 640,
    height: 360,
  });
  const before = await sharp(input).ensureAlpha().raw().toBuffer();
  const after = await sharp(output).ensureAlpha().raw().toBuffer();
  for (let i = 3; i < before.length; i += 4)
    assert.equal(after[i], before[i], "Alpha at pixel " + (i - 3) / 4);
});

test("APNG, invalid CRCs, too many pixels, unsupported bit depth and non-PNG inputs never decode", async () => {
  const image = await screenshot(32, 32);
  const broken = Buffer.from(image);
  broken[29] = broken[29]! ^ 1;
  const header = Buffer.from(image.subarray(16, 29));
  header.writeUInt32BE(100000);
  header.writeUInt32BE(100000, 4);
  const oversized = Buffer.concat([
    image.subarray(0, 8),
    pngChunk("IHDR", header),
    image.subarray(33),
  ]);
  const wideHeader = Buffer.from(image.subarray(16, 29));
  wideHeader.writeUInt32BE(20000);
  wideHeader.writeUInt32BE(1, 4);
  const wide = Buffer.concat([
    image.subarray(0, 8),
    pngChunk("IHDR", wideHeader),
    image.subarray(33),
  ]);
  const deepHeader = Buffer.from(image.subarray(16, 29));
  deepHeader[8] = 16;
  const deep = Buffer.concat([
    image.subarray(0, 8),
    pngChunk("IHDR", deepHeader),
    image.subarray(33),
  ]);
  for (const input of [
    animatedPng(),
    broken,
    oversized,
    wide,
    deep,
    Buffer.from("not png"),
    image.subarray(0, 30),
  ]) {
    assert.equal(staticPng(input), undefined);
    assert.equal(await new PngWebpEncoder().webp(input), undefined);
  }
});

test("deadline, abort and a busy codec have no waiting queue and preserve original fallback", async () => {
  const input = await screenshot(1280, 720, 50);
  assert.equal(await new PngWebpEncoder(1).webp(input), undefined);
  const encoder = new PngWebpEncoder();
  const abort = new AbortController();
  const first = encoder.webp(input, abort.signal);
  const rejected = assert.rejects(first, { name: "AbortError" });
  assert.equal(await encoder.webp(input), undefined);
  abort.abort();
  await rejected;
  assert.ok(
    await encoder.webp(input),
    "Capacity is released after the killed process closes",
  );
});

test("tiny/no-benefit PNGs stay exact originals instead of storing a larger WebP", async () => {
  const input = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 31, g: 91, b: 151, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const candidate = await sharp(input).webp().toBuffer();
  assert.ok(
    candidate.length >= input.length,
    "Fixture is an actual no-benefit encode",
  );
  assert.equal(await new PngWebpEncoder().webp(input), undefined);
});

test("compressed metadata is bounded before decode; normal small ICC profiles remain eligible", async () => {
  const input = await screenshot(320, 180);
  const profile = Buffer.alloc(2 * 1024 * 1024);
  profile.writeUInt32BE(profile.length);
  const bomb = Buffer.concat([
    input.subarray(0, 33),
    pngChunk(
      "iCCP",
      Buffer.concat([
        Buffer.from("profile"),
        Buffer.from([0, 0]),
        deflateSync(profile),
      ]),
    ),
    input.subarray(33),
  ]);
  assert.equal(staticPng(bomb), undefined);
  assert.equal(await new PngWebpEncoder().webp(bomb), undefined);
  const text = Buffer.concat([
    input.subarray(0, 33),
    pngChunk(
      "zTXt",
      Buffer.concat([
        Buffer.from("text"),
        Buffer.from([0, 0]),
        deflateSync(profile),
      ]),
    ),
    input.subarray(33),
  ]);
  assert.equal(staticPng(text), undefined);
  const tagged = await sharp(input).withIccProfile("srgb").png().toBuffer();
  assert.deepEqual(staticPng(tagged), { width: 320, height: 180 });
  assert.ok(await new PngWebpEncoder().webp(tagged));
});
