import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { WorkspaceAttachmentFiles } from "../adapter/workspace-attachment-files.js";
import { attachmentLimits } from "../model/attachment.js";
import { attachmentStagingFolder } from "../model/attachment-file.js";
import { AttachmentService } from "../service/attachment-service.js";
import {
  agents,
  agentId,
  ownerId,
  chunks,
  MemoryAttachments,
} from "./attachment-fixtures.js";
import { screenshot } from "./synthetic-screenshot.js";

/** Reproducible synthetic-only measurements; caller supplies a new absolute owned directory. */
const output = process.argv[2];
if (!output || !path.isAbsolute(output))
  throw new Error("Supply a fresh absolute benchmark directory");
await mkdir(output);
const root = path.join(output, "volume");
const workspaces = new FileSystemWorkspaces(root);
await workspaces.createShared();
const service = new AttachmentService(
  agents,
  new MemoryAttachments(),
  new WorkspaceAttachmentFiles(root, workspaces),
);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const results = [];
for (const spec of [
  { name: "proof", width: 640, height: 360, grain: 8, alpha: true },
  { name: "desktop", width: 1920, height: 1080, grain: 8, alpha: true },
  {
    name: "textured-desktop",
    width: 1920,
    height: 1080,
    grain: 128,
    alpha: true,
  },
  { name: "flat-desktop", width: 1920, height: 1080, grain: 0, alpha: true },
]) {
  const input = await screenshot(
    spec.width,
    spec.height,
    spec.grain,
    spec.alpha,
  );
  await writeFile(path.join(output, spec.name + ".original.png"), input, {
    flag: "wx",
  });
  // Candidate measurement uses the exact same unmodified .webp() defaults, including no-benefit cases.
  const candidate = await sharp(input).webp().toBuffer();
  let upload = await service.create(ownerId, agentId, {
    name: spec.name + ".png",
    size: input.length,
  });
  for (
    let offset = 0;
    offset < input.length;
    offset += attachmentLimits.chunkBytes
  )
    upload = await service.append(
      ownerId,
      agentId,
      upload.id,
      offset,
      chunks(input.subarray(offset, offset + attachmentLimits.chunkBytes)),
    );
  assert.equal(upload.received, input.length);
  assert.equal(upload.inputSize, input.length);
  const local = path.join(root, path.posix.relative("/workspace", upload.path));
  const stored = await readFile(local);
  const converted = upload.mediaType === "image/webp";
  assert.deepEqual(await readdir(path.dirname(local)), [path.basename(local)]);
  assert.deepEqual(await readdir(path.join(root, attachmentStagingFolder)), []);
  assert.equal(stored.length, upload.size);
  assert.deepEqual(stored, converted ? candidate : input);
  if (spec.name === "proof")
    assert.ok(
      converted,
      "Real production storage/codec must convert the proof",
    );
  const metadata = await sharp(stored).metadata();
  assert.equal(metadata.width, spec.width);
  assert.equal(metadata.height, spec.height);
  const before = await sharp(input).ensureAlpha().raw().toBuffer();
  const after = await sharp(stored).ensureAlpha().raw().toBuffer();
  let alphaExact = true,
    rgbError = 0;
  for (let i = 0; i < before.length; i += 4) {
    alphaExact &&= before[i + 3] === after[i + 3];
    for (let c = 0; c < 3; c++)
      rgbError += Math.abs(before[i + c]! - after[i + c]!);
  }
  assert.ok(alphaExact);
  const storedName = spec.name + ".stored." + (converted ? "webp" : "png");
  await writeFile(path.join(output, storedName), stored, { flag: "wx" });
  results.push({
    ...spec,
    seed: "0x1a194cd",
    sourceBytes: input.length,
    candidateWebpBytes: candidate.length,
    storedBytes: stored.length,
    savedPercent: Math.round((1 - stored.length / input.length) * 10000) / 100,
    converted,
    originalName: spec.name + ".original.png",
    storedName,
    canonicalName: upload.name,
    mediaType: upload.mediaType,
    sourceSha256: hash(input),
    candidateWebpSha256: hash(candidate),
    storedSha256: hash(stored),
    inputSize: upload.inputSize,
    received: upload.received,
    width: metadata.width,
    height: metadata.height,
    alphaExact,
    rgbMeanAbsoluteError:
      Math.round((rgbError / (spec.width * spec.height * 3)) * 1000) / 1000,
    permanentFiles: 1,
    privatePartials: 0,
  });
}
const report = {
  codec: "sharp",
  version: sharp.versions.sharp,
  versions: sharp.versions,
  platform: process.platform,
  architecture: process.arch,
  webpCall: ".webp() with no options and no resize/rotation",
  defaults: { quality: 80, alphaQuality: 100, effort: 4, lossless: false },
  metadata:
    "Default sRGB conversion/metadata stripping; EXIF-bearing PNGs are kept original",
  source:
    "Entirely deterministic generated RGBA screenshot/text/alpha fixtures; grain is synthetic, not real user content",
  qualification:
    "Standard lossy defaults; not lossless/bit-exact RGB or universal savings. Measurements use actual upload service/storage/codec over a temporary volume; HTTP transport is covered separately and candidate encodes are measured separately for no-benefit policy.",
  results,
};
await writeFile(
  path.join(output, "BENCHMARK.json"),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify(report, null, 2));
