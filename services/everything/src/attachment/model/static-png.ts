import { crc32, inflateSync } from "node:zlib";
import {
  imageDimensions,
  imageMediaType,
  maxImagePixels,
} from "../../workspace/model/image-format.js";

/** WebP's format limit, not a resize target: wider/taller PNGs remain unchanged. */
const webpDimensionLimit = 16383;

/** Inspect bounded chunks/CRCs before a codec allocates pixels; APNG/16-bit/unusual files stay original. */
export function staticPng(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (imageMediaType(bytes) !== "image/png") return undefined;
  const dimensions = imageDimensions(bytes, "image/png");
  if (
    !dimensions ||
    !dimensions.width ||
    !dimensions.height ||
    dimensions.width * dimensions.height > maxImagePixels ||
    dimensions.width > webpDimensionLimit ||
    dimensions.height > webpDimensionLimit
  )
    return undefined;
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8,
    chunks = 0,
    pixels = false;
  let profileSeen = false;
  while (offset + 12 <= data.length && ++chunks <= 4096) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) return undefined;
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (
      type === "acTL" ||
      type === "fcTL" ||
      type === "fdAT" ||
      type === "eXIf"
    )
      return undefined;
    if (
      crc32(data.subarray(offset + 4, offset + 8 + length)) !==
      data.readUInt32BE(offset + 8 + length)
    )
      return undefined;
    // Pixel limits alone don't bound compressed ancillary metadata. Keep unusual text/profile inputs original.
    if (type === "zTXt") return undefined;
    if (type === "iTXt") {
      const body = data.subarray(offset + 8, offset + 8 + length);
      const separator = body.indexOf(0);
      if (separator < 1 || separator > 79 || body[separator + 1] !== 0)
        return undefined;
    }
    if (type === "iCCP") {
      if (profileSeen) return undefined;
      profileSeen = true;
      const body = data.subarray(offset + 8, offset + 8 + length);
      const separator = body.indexOf(0);
      if (separator < 1 || separator > 79 || body[separator + 1] !== 0)
        return undefined;
      try {
        const profile = inflateSync(body.subarray(separator + 2), {
          maxOutputLength: 1024 * 1024,
        });
        if (profile.length < 128 || profile.readUInt32BE(0) !== profile.length)
          return undefined;
      } catch {
        return undefined;
      }
    }
    if (
      chunks === 1 &&
      (type !== "IHDR" ||
        length !== 13 ||
        ![1, 2, 4, 8].includes(data[offset + 16]!))
    )
      return undefined;
    if (chunks !== 1 && type === "IHDR") return undefined;
    if (type === "IDAT") pixels = true;
    offset += length + 12;
    if (type === "IEND")
      return length === 0 && pixels && offset === data.length
        ? dimensions
        : undefined;
  }
  return undefined;
}
