import assert from "node:assert/strict";
import { test } from "node:test";
import { png } from "../../attachment/test/attachment-fixtures.js";
import { imageDimensions, imageMediaType } from "../model/image-format.js";

test("image sizes are read from headers without decoding pixels", () => {
  assert.deepEqual(imageDimensions(png(37, 5), "image/png"), {
    width: 37,
    height: 5,
  });
  const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
  assert.equal(imageMediaType(gif), "image/gif");
  assert.deepEqual(imageDimensions(gif, "image/gif"), {
    width: 320,
    height: 240,
  });
  // JPEG: SOI, an APP0 segment to skip, then a baseline frame header of 640×480.
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
    0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
  ]);
  assert.equal(imageMediaType(jpeg), "image/jpeg");
  assert.deepEqual(imageDimensions(jpeg, "image/jpeg"), {
    width: 640,
    height: 480,
  });
  // Extended WebP stores width and height minus one in 24 bits each.
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBPVP8X", 8, "ascii");
  webp.writeUIntLE(1023, 24, 3);
  webp.writeUIntLE(767, 27, 3);
  assert.deepEqual(imageDimensions(webp, "image/webp"), {
    width: 1024,
    height: 768,
  });
  assert.equal(
    imageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"),
    undefined,
  );
  assert.equal(imageMediaType(Buffer.from("<svg/>")), undefined);
});
