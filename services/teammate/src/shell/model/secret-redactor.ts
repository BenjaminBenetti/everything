/** Text that replaces each occurrence of a secret. */
export const redactedText = "[redacted]";

/** Secrets shorter than this are not redacted: they would match ordinary output. */
const shortestSecret = 16;

/**
 * At most this much output is held back behind a possible beginning of a secret in one stream, so a
 * quiet stream cannot hold up the others' output indefinitely or without bound in memory.
 */
const interleavedBytes = 4096;

/**
 * Held output beyond this many times the hold limit is released at once, so chains of possible
 * secrets in several streams cannot keep output back without bound.
 */
const retainedLimits = 2;

/** A part of the held output, from `start` up to `end`, by position in the joined output. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** Consecutive held output one stream wrote. */
interface Run {
  readonly source: number;
  length: number;
}

/**
 * Some of the held output as one sequence of bytes, either all of it or one stream's part, with the
 * spans of the joined output its bytes come from, in order.
 */
interface View {
  readonly bytes: Buffer;
  readonly spans: readonly Span[];
}

/**
 * Replace every occurrence of known secrets in the output of one or more streams joined in the order
 * they write, such as a command's stdout and stderr, without reordering it. A secret is found whole
 * in the joined output, split between streams, and within one stream even when up to 4 KiB of
 * another stream's output falls between its parts, and in each case across chunks: output that could
 * begin a secret is held back, with everything after it, until later output or the end decides it.
 * At most 8 KiB is held: beyond that, held output is released at once, so a secret split within one
 * stream while that much is held is then not recognized as a whole. Removing an occurrence within
 * one stream can join the bytes around it into a new one, so the released output passes through a
 * final redaction of the joined output as released: what the redactor returns never contains a
 * whole secret, unless the secret itself contains `[` or `]` and so can overlap the mark. This
 * keeps secrets out of tool output by accident, not from a command set on revealing them: an
 * encoded or transformed secret is not recognized, and secrets are those known when the redactor is
 * made.
 */
export class SecretRedactor {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly secrets: readonly Buffer[];
  private readonly holdLimit: number;
  /** The final redaction of the released output. */
  private readonly released: ContiguousRedactor;
  /** Output not yet released, in the order it was written, and the runs each stream wrote of it. */
  private pending = Buffer.alloc(0);
  private runs: Run[] = [];
  private streams = 0;

  /** Redact `secrets`, ignoring empty and short values. */
  constructor(secrets: readonly string[]) {
    this.secrets = secrets
      .filter((secret) => secret.length >= shortestSecret)
      .map((secret) => Buffer.from(secret, "utf8"));
    this.holdLimit = Math.max(
      interleavedBytes,
      ...this.secrets.map((secret) => secret.length),
    );
    this.released = new ContiguousRedactor(this.secrets);
  }

  // ===========================================
  // Redaction
  // ===========================================

  /** Join one more stream: the returned function takes each chunk it writes and returns what can be released. */
  stream(): (chunk: Buffer) => Buffer {
    const source = this.streams++;
    return (chunk) => {
      if (this.secrets.length === 0) return chunk;
      this.pending = Buffer.concat([this.pending, chunk]);
      const last = this.runs.at(-1);
      if (last?.source === source) last.length += chunk.length;
      else this.runs.push({ source, length: chunk.length });
      const released = this.release(false);
      // A chain of possible secrets across streams could otherwise hold output back without bound.
      return this.released.push(
        this.pending.length > retainedLimits * this.holdLimit
          ? Buffer.concat([released, this.release(true)])
          : released,
      );
    };
  }

  /** Release everything held back, once every stream has ended. */
  end(): Buffer {
    if (this.secrets.length === 0) return Buffer.alloc(0);
    return Buffer.concat([
      this.released.push(this.release(true)),
      this.released.end(),
    ]);
  }

  /**
   * Release the held output up to the first byte that could still begin a secret, unless the output
   * ended, with each whole occurrence replaced. An occurrence is released only whole, so the part of
   * the output kept back never begins inside one.
   */
  private release(final: boolean): Buffer {
    const occurrences: Span[][] = [];
    let held = this.pending.length;
    for (const view of this.views()) {
      const scanned = this.scan(view);
      occurrences.push(...scanned.occurrences);
      if (
        !final &&
        scanned.partial !== undefined &&
        this.pending.length - scanned.partial <= this.holdLimit
      )
        held = Math.min(held, scanned.partial);
    }
    for (let moved = true; moved;) {
      moved = false;
      for (const spans of occurrences)
        if (spans[0]!.start < held && spans.at(-1)!.end > held) {
          held = spans[0]!.start;
          moved = true;
        }
    }
    const hidden = occurrences
      .filter((spans) => spans[0]!.start < held)
      .flatMap((spans) =>
        spans.map((span, index) => ({ ...span, first: index === 0 })),
      )
      .sort((left, right) => left.start - right.start);
    const released: Buffer[] = [];
    let from = 0;
    for (const { start, end, first } of hidden) {
      if (start > from) released.push(this.pending.subarray(from, start));
      // Views can find the same occurrence, or overlapping ones: the output marks each place once.
      if (first && start >= from) released.push(Buffer.from(redactedText));
      from = Math.max(from, end);
    }
    released.push(this.pending.subarray(from, Math.max(from, held)));
    this.keep(held);
    return Buffer.concat(released);
  }

  /** Keep only the held output from `held` on. */
  private keep(held: number): void {
    this.pending = Buffer.from(this.pending.subarray(held));
    let dropped = held;
    while (dropped > 0 && this.runs.length > 0) {
      const run = this.runs[0]!;
      if (run.length > dropped) {
        run.length -= dropped;
        break;
      }
      dropped -= run.length;
      this.runs.shift();
    }
  }

  /** The held output as written, and, when more than one stream wrote it, each stream's part of it. */
  private views(): View[] {
    const joined = {
      bytes: this.pending,
      spans: [{ start: 0, end: this.pending.length }],
    };
    if (this.runs.length < 2) return [joined];
    const streams = new Map<number, Span[]>();
    let start = 0;
    for (const { source, length } of this.runs) {
      const spans = streams.get(source) ?? [];
      spans.push({ start, end: start + length });
      streams.set(source, spans);
      start += length;
    }
    return [
      joined,
      ...[...streams.values()].map((spans) => ({
        bytes: Buffer.concat(
          spans.map(({ start, end }) => this.pending.subarray(start, end)),
        ),
        spans,
      })),
    ];
  }

  /**
   * The occurrences of secrets in `view`, first to last, as spans of the joined output, and where in
   * the joined output the longest end of the view that could begin a secret starts.
   */
  private scan(view: View): {
    occurrences: Span[][];
    partial: number | undefined;
  } {
    const occurrences: Span[][] = [];
    let position = 0;
    for (;;) {
      const next = nextOccurrence(this.secrets, view.bytes, position);
      if (!next) break;
      position = next.at + next.secret.length;
      occurrences.push(this.spansOf(view, next.at, position));
    }
    const length = partialLength(this.secrets, view.bytes.subarray(position));
    return {
      occurrences,
      partial:
        length > 0
          ? this.spansOf(
              view,
              view.bytes.length - length,
              view.bytes.length,
            )[0]!.start
          : undefined,
    };
  }

  /** The spans of the joined output that bytes `from` up to `to` of `view` come from. */
  private spansOf(view: View, from: number, to: number): Span[] {
    const spans: Span[] = [];
    let offset = 0;
    for (const { start, end } of view.spans) {
      const length = end - start;
      const low = Math.max(from, offset);
      const high = Math.min(to, offset + length);
      if (low < high)
        spans.push({ start: start + low - offset, end: start + high - offset });
      offset += length;
      if (offset >= to) break;
    }
    return spans;
  }
}

/**
 * Replace every occurrence of known secrets in one sequence of output, including an occurrence split
 * across chunks: the end of a chunk that could begin a secret is held back until the next chunk or
 * the end decides it.
 */
class ContiguousRedactor {
  private pending = Buffer.alloc(0);

  constructor(private readonly secrets: readonly Buffer[]) {}

  /** Return the redacted bytes that can be released now. */
  push(chunk: Buffer): Buffer {
    if (this.secrets.length === 0) return chunk;
    return this.scan(Buffer.concat([this.pending, chunk]), false);
  }

  /** Release everything held back, at the end of the output. */
  end(): Buffer {
    if (this.secrets.length === 0) return Buffer.alloc(0);
    return this.scan(this.pending, true);
  }

  /** Replace whole occurrences, then hold back a tail that could begin one unless the output ended. */
  private scan(data: Buffer, final: boolean): Buffer {
    const released: Buffer[] = [];
    let position = 0;
    for (;;) {
      const next = nextOccurrence(this.secrets, data, position);
      if (!next) break;
      released.push(
        data.subarray(position, next.at),
        Buffer.from(redactedText),
      );
      position = next.at + next.secret.length;
    }
    const rest = data.subarray(position);
    const held = final ? 0 : partialLength(this.secrets, rest);
    released.push(rest.subarray(0, rest.length - held));
    this.pending = Buffer.from(rest.subarray(rest.length - held));
    return Buffer.concat(released);
  }
}

/** The first occurrence of any of `secrets` in `bytes` from `position` on. */
function nextOccurrence(
  secrets: readonly Buffer[],
  bytes: Buffer,
  position: number,
): { secret: Buffer; at: number } | undefined {
  return secrets
    .map((secret) => ({ secret, at: bytes.indexOf(secret, position) }))
    .filter(({ at }) => at >= 0)
    .sort((left, right) => left.at - right.at)[0];
}

/** Length of the longest end of `bytes` that is the beginning of one of `secrets`. */
function partialLength(secrets: readonly Buffer[], bytes: Buffer): number {
  let longest = 0;
  for (const secret of secrets)
    for (
      let length = Math.min(secret.length - 1, bytes.length);
      length > longest;
      length--
    )
      if (
        bytes.subarray(bytes.length - length).equals(secret.subarray(0, length))
      ) {
        longest = length;
        break;
      }
  return longest;
}
