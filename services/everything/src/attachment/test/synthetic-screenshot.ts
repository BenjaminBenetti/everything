import sharp from "sharp";
import { crc32, deflateSync } from "node:zlib";

/** Small deterministic bitmap alphabet, avoiding host fonts or any private screenshot fixture. */
const letters: Record<string, string> = {
  A: "01110100011000111111100011000110001",
  B: "11110100011000111110100011000111110",
  C: "01111100001000010000100001000001111",
  D: "11110100011000110001100011000111110",
  E: "11111100001000011110100001000011111",
  F: "11111100001000011110100001000010000",
  G: "01111100001000010111100011000101111",
  H: "10001100011000111111100011000110001",
  I: "11111001000010000100001000010011111",
  J: "00111000100001000010100101001001100",
  K: "10001100101010011000101001001010001",
  L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001",
  N: "10001110011010110011100011000110001",
  O: "01110100011000110001100011000101110",
  P: "11110100011000111110100001000010000",
  Q: "01110100011000110001101011001001101",
  R: "11110100011000111110101001001010001",
  S: "01111100001000001110000010000111110",
  T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110",
  V: "10001100011000110001100010101000100",
  W: "10001100011000110101101011101110001",
  X: "10001100010101000100010101000110001",
  Y: "10001100010101000100001000010000100",
  Z: "11111000010001000100010001000011111",
  "0": "01110100011001110101110011000101110",
  "1": "00100011000010000100001000010001110",
  "2": "01110100010000100010001000100011111",
  "3": "11110000010000101110000010000111110",
  "4": "00010001100101010010111110001000010",
  "5": "11111100001000011110000010000111110",
  "6": "01110100001000011110100011000101110",
  "7": "11111000010001000100010000100001000",
  "8": "01110100011000101110100011000101110",
  "9": "01110100011000101111000010000101110",
  ".": "00000000000000000000000000011000110",
  "-": "00000000000000011111000000000000000",
};

/** Synthetic screenshot-style RGBA pixels with deterministic grain, crisp text and optional alpha. */
export function screenshotPixels(
  width: number,
  height: number,
  seed = 0x1a194cd,
  grain = 8,
  alpha = false,
): Buffer {
  const bytes = Buffer.alloc(width * height * 4);
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        bytes[i + c] = Math.max(
          0,
          Math.min(
            255,
            205 +
              c * 4 +
              Math.floor(((random() & 255) * grain) / 255) -
              grain / 2,
          ),
        );
      bytes[i + 3] = alpha && x < 12 ? Math.round((x * 255) / 11) : 255;
    }
  const rectangle = (
    x: number,
    y: number,
    w: number,
    h: number,
    color: number[],
  ) => {
    for (let row = y; row < Math.min(y + h, height); row++)
      for (let col = x; col < Math.min(x + w, width); col++)
        bytes.set(color, (row * width + col) * 4);
  };
  const text = (value: string, x: number, y: number, scale = 2) => {
    for (const character of value) {
      const glyph = letters[character];
      if (glyph)
        for (let row = 0; row < 7; row++)
          for (let col = 0; col < 5; col++)
            if (glyph[row * 5 + col] === "1")
              rectangle(
                x + col * scale,
                y + row * scale,
                scale,
                scale,
                [248, 249, 252, 255],
              );
      x += 6 * scale;
    }
  };
  rectangle(16, 14, width - 32, 38, [28, 35, 49, 255]);
  text("PROJECT UPLOADS 2026", 28, 25);
  for (let y = 82, n = 1; y + 40 < height; y += 70, n++) {
    rectangle(24, y, Math.min(width - 48, 560), 42, [44, 62, 84, 255]);
    text("REPORT " + n + " - SAME RESOLUTION", 36, y + 12);
    rectangle(24, y + 50, width - 48, 1, [145, 155, 172, 255]);
  }
  return bytes;
}

/** Normal full-resolution PNG input; only WebP output settings are the production encoder's choice. */
export async function screenshot(
  width = 640,
  height = 360,
  grain = 8,
  alpha = true,
): Promise<Buffer> {
  return sharp(screenshotPixels(width, height, 0x1a194cd, grain, alpha), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** Build a real CRC-bearing PNG chunk, including animation/oversize fixtures without decoding them. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}

/** A two-frame APNG with actual complete frame streams. Never flattened by the upload encoder. */
export function animatedPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2);
  const control = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence);
    data.writeUInt32BE(2, 4);
    data.writeUInt32BE(1, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return data;
  };
  const frame = (red: number) =>
    deflateSync(Buffer.from([0, red, 30, 40, 255, red, 60, 80, 128]));
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32BE(2);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("acTL", animation),
    pngChunk("fcTL", control(0)),
    pngChunk("IDAT", frame(200)),
    pngChunk("fcTL", control(1)),
    pngChunk("fdAT", Buffer.concat([sequence, frame(20)])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
