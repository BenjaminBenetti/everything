/** Drop a trailing UTF-8 sequence that was cut short so decoding never invents replacement text. */
function completePrefix(bytes: Buffer): Buffer {
  let start = bytes.length - 1;
  // Find the lead byte of the final sequence, skipping at most three continuation bytes.
  while (
    start >= 0 &&
    bytes.length - start < 4 &&
    (bytes[start]! & 0xc0) === 0x80
  )
    start--;
  if (start < 0) return bytes;
  const lead = bytes[start]!;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return start + length > bytes.length ? bytes.subarray(0, start) : bytes;
}

/** Skip continuation bytes left at the start of a slice by an earlier cut. */
function completeSuffix(bytes: Buffer): Buffer {
  let start = 0;
  while (start < Math.min(bytes.length, 3) && (bytes[start]! & 0xc0) === 0x80)
    start++;
  return bytes.subarray(start);
}

/**
 * Keep the beginning and the end of a command's combined output within a fixed memory budget,
 * counting everything written so the caller can report how much was omitted.
 */
export class BoundedOutput {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly head: Buffer[] = [];
  private headSize = 0;
  private tail = Buffer.alloc(0);
  private total = 0;

  /** Retain up to `headBytes` from the start and `tailBytes` from the end. */
  constructor(
    private readonly headBytes: number,
    private readonly tailBytes: number,
  ) {}

  // ===========================================
  // Collection
  // ===========================================

  /** Record a chunk, filling the head first and keeping only the newest bytes after it. */
  append(chunk: Buffer): void {
    this.total += chunk.length;
    const toHead = Math.min(this.headBytes - this.headSize, chunk.length);
    if (toHead > 0) {
      this.head.push(chunk.subarray(0, toHead));
      this.headSize += toHead;
    }
    const rest = chunk.subarray(toHead);
    if (rest.length === 0) return;
    this.tail = Buffer.concat([this.tail, rest]);
    if (this.tail.length > this.tailBytes)
      this.tail = this.tail.subarray(this.tail.length - this.tailBytes);
  }

  /** Total bytes written, including any that were not retained. */
  get bytes(): number {
    return this.total;
  }

  /** Whether output between the head and the tail was dropped. */
  get truncated(): boolean {
    return this.total > this.headSize + this.tail.length;
  }

  /** Decode the retained output, marking any omission without splitting a UTF-8 character. */
  text(): string {
    const head = Buffer.concat(this.head);
    if (!this.truncated)
      return Buffer.concat([head, this.tail]).toString("utf8");
    const omitted = this.total - this.headSize - this.tail.length;
    return `${completePrefix(head).toString("utf8")}\n[… ${omitted} bytes omitted …]\n${completeSuffix(this.tail).toString("utf8")}`;
  }
}
