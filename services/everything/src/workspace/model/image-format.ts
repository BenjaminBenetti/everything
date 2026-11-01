/** Raster formats a browser can display safely and a vision model can read. */
export const imageMediaTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ImageMediaType = (typeof imageMediaTypes)[number];

/** Largest image, in pixels, decoded for a model; bigger pictures could exhaust memory when decoded. */
export const maxImagePixels = 40_000_000;

/** The supported raster format `bytes` begins with, recognized by its signature. */
export function imageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const signature = ascii(bytes, 0, 6);
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return "image/webp";
  return undefined;
}

/**
 * Width and height from an image's header, read without decoding its pixels, or undefined when the
 * header is incomplete or not understood.
 */
export function imageDimensions(
  bytes: Uint8Array,
  mediaType: ImageMediaType,
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (offset: number, length: number) =>
    offset + length <= bytes.byteLength;
  switch (mediaType) {
    case "image/png":
      return at(16, 8)
        ? { width: view.getUint32(16), height: view.getUint32(20) }
        : undefined;
    case "image/gif":
      return at(6, 4)
        ? { width: view.getUint16(6, true), height: view.getUint16(8, true) }
        : undefined;
    case "image/webp":
      return webpDimensions(bytes, view);
    case "image/jpeg":
      return jpegDimensions(bytes, view);
  }
}

/** Read the size from a WebP file's lossy, lossless, or extended header. */
function webpDimensions(
  bytes: Uint8Array,
  view: DataView,
): { width: number; height: number } | undefined {
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8 " && bytes.byteLength >= 30)
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  if (chunk === "VP8L" && bytes.byteLength >= 25) {
    const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X" && bytes.byteLength >= 30)
    return {
      width: 1 + (view.getUint16(24, true) | (bytes[26]! << 16)),
      height: 1 + (view.getUint16(27, true) | (bytes[29]! << 16)),
    };
  return undefined;
}

/** Walk a JPEG's marker segments to the frame header that holds its size. */
function jpegDimensions(
  bytes: Uint8Array,
  view: DataView,
): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Start-of-frame markers, excluding DHT (C4), JPG (C8), and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    // Markers without a length: restarts, start and end of image, and TEM.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      offset += 2;
      continue;
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return undefined;
}

/** Whether `bytes` begins with `prefix`. */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

/** The bytes from `start` to `end` read as ASCII. */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
