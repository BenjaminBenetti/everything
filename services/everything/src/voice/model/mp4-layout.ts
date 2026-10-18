import { VoiceRecordingInvalidError } from "../error/voice-errors.js";

/** One ISO base media box located within a buffer. */
interface Box {
  readonly type: string;
  readonly start: number;
  readonly size: number;
  readonly headerSize: number;
}

/**
 * The only path to chunk offset tables: each container's child that is followed. Walking this fixed
 * path, rather than any box with a container's name, limits nesting to five levels however the file
 * is built.
 */
const offsetPath: Readonly<Record<string, string>> = {
  moov: "trak",
  trak: "mdia",
  mdia: "minf",
  minf: "stbl",
};

/** Most boxes read from one file; real recordings have a few hundred, mostly media fragments. */
const maxBoxes = 65_536;

/** Largest value a 32-bit chunk offset can hold. */
const maxChunkOffset = 0xffff_ffff;

/** Boxes that may still be read from the current file. */
interface BoxBudget {
  remaining: number;
}

/**
 * Place the movie box before the media data, as `-movflags +faststart` would, so a decoder reading
 * from a pipe finds the sample tables before the samples. Chunk offsets into the moved media data
 * are shifted by the movie box's size. Files already in that order, including fragmented MP4, are
 * returned unchanged.
 */
export function movieBoxFirst(bytes: Buffer): Buffer {
  const budget: BoxBudget = { remaining: maxBoxes };
  const boxes = readBoxes(bytes, 0, bytes.length, budget);
  const movie = boxes.find((box) => box.type === "moov");
  const media = boxes.find((box) => box.type === "mdat");
  if (!movie || !media || movie.start < media.start) return bytes;
  const movedMovie = Buffer.from(
    bytes.subarray(movie.start, movie.start + movie.size),
  );
  shiftChunkOffsets(
    movedMovie,
    { ...movie, start: 0 },
    { from: media.start, to: movie.start, by: movie.size },
    budget,
  );
  return Buffer.concat([
    bytes.subarray(0, media.start),
    movedMovie,
    bytes.subarray(media.start, movie.start),
    bytes.subarray(movie.start + movie.size),
  ]);
}

/** Read consecutive boxes between two offsets, rejecting sizes that leave their parent. */
function readBoxes(
  bytes: Buffer,
  start: number,
  end: number,
  budget: BoxBudget,
): Box[] {
  const boxes: Box[] = [];
  for (let offset = start; offset < end;) {
    if (end - offset < 8 || --budget.remaining < 0)
      throw new VoiceRecordingInvalidError();
    let size = bytes.readUInt32BE(offset);
    let headerSize = 8;
    if (size === 1) {
      if (end - offset < 16) throw new VoiceRecordingInvalidError();
      const largeSize = bytes.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(end - offset))
        throw new VoiceRecordingInvalidError();
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) size = end - offset;
    if (size < headerSize || size > end - offset)
      throw new VoiceRecordingInvalidError();
    boxes.push({
      type: bytes.toString("latin1", offset + 4, offset + 8),
      start: offset,
      size,
      headerSize,
    });
    offset += size;
  }
  return boxes;
}

/**
 * Shift every 32- and 64-bit chunk offset that points into the moved media range, in place, following
 * only the fixed path from the movie box to its sample tables.
 */
function shiftChunkOffsets(
  movie: Buffer,
  container: Box,
  shift: { from: number; to: number; by: number },
  budget: BoxBudget,
): void {
  const children = readBoxes(
    movie,
    container.start + container.headerSize,
    container.start + container.size,
    budget,
  );
  for (const box of children)
    if (box.type === offsetPath[container.type])
      shiftChunkOffsets(movie, box, shift, budget);
    else if (
      container.type === "stbl" &&
      (box.type === "stco" || box.type === "co64")
    )
      shiftTable(movie, box, shift);
}

/** Shift the entries of one chunk offset table that point into the moved media range. */
function shiftTable(
  movie: Buffer,
  table: Box,
  shift: { from: number; to: number; by: number },
): void {
  const contentStart = table.start + table.headerSize;
  const end = table.start + table.size;
  const wide = table.type === "co64";
  const entrySize = wide ? 8 : 4;
  // A full box: version and flags, then the entry count and the entries.
  if (end - contentStart < 8) throw new VoiceRecordingInvalidError();
  const count = movie.readUInt32BE(contentStart + 4);
  const entries = contentStart + 8;
  if (count > (end - entries) / entrySize)
    throw new VoiceRecordingInvalidError();
  for (let index = 0; index < count; index++) {
    const position = entries + index * entrySize;
    const offset = wide
      ? Number(movie.readBigUInt64BE(position))
      : movie.readUInt32BE(position);
    if (offset < shift.from || offset >= shift.to) continue;
    const shifted = offset + shift.by;
    if (wide) movie.writeBigUInt64BE(BigInt(shifted), position);
    else if (shifted > maxChunkOffset) throw new VoiceRecordingInvalidError();
    else movie.writeUInt32BE(shifted, position);
  }
}
