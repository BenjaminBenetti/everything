import sharp from "sharp";

// One isolated image per process; parent enforces byte/pixel bounds, concurrency and kill deadline.
sharp.cache(false);
sharp.concurrency(1);
try {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of process.stdin) {
    size += part.length;
    if (size > 25 * 1024 * 1024) throw new Error("Input limit");
    parts.push(part as Buffer);
  }
  // Ordinary documented WebP defaults: quality80, alphaQuality100, effort4, lossy; no resize/rotate.
  const result = await sharp(Buffer.concat(parts, size), {
    limitInputPixels: 40_000_000,
    failOn: "warning",
  })
    .webp()
    .timeout({ seconds: 8 })
    .toBuffer();
  if (result.length < size) process.stdout.write(result);
} catch {
  process.exitCode = 1;
}
