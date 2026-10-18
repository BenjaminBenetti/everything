/** Text that replaces each occurrence of a secret. */
export const redactedText = "[redacted]";

/** Secrets shorter than this are not redacted: they would match ordinary output. */
const shortestSecret = 16;

/**
 * Replace every occurrence of known secrets in one output stream, including an occurrence split
 * across chunks: the end of a chunk that could begin a secret is held back until the next chunk or
 * the end of the stream decides it. This keeps secrets out of tool output by accident, not from a
 * command set on revealing them: an encoded or transformed secret is not recognized, and secrets are
 * those known when the redactor is made.
 */
export class SecretRedactor {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly secrets: readonly Buffer[];
  private pending = Buffer.alloc(0);

  /** Redact `secrets`, ignoring empty and short values. */
  constructor(secrets: readonly string[]) {
    this.secrets = secrets
      .filter((secret) => secret.length >= shortestSecret)
      .map((secret) => Buffer.from(secret, "utf8"));
  }

  // ===========================================
  // Redaction
  // ===========================================

  /** Return the redacted bytes that can be released now. */
  push(chunk: Buffer): Buffer {
    if (this.secrets.length === 0) return chunk;
    return this.scan(Buffer.concat([this.pending, chunk]), false);
  }

  /** Release everything held back, at the end of the stream. */
  end(): Buffer {
    if (this.secrets.length === 0) return Buffer.alloc(0);
    return this.scan(this.pending, true);
  }

  /** Replace whole occurrences, then hold back a tail that could begin one unless the stream ended. */
  private scan(data: Buffer, final: boolean): Buffer {
    const released: Buffer[] = [];
    let position = 0;
    for (;;) {
      const next = this.secrets
        .map((secret) => ({ secret, at: data.indexOf(secret, position) }))
        .filter(({ at }) => at >= 0)
        .sort((left, right) => left.at - right.at)[0];
      if (!next) break;
      released.push(
        data.subarray(position, next.at),
        Buffer.from(redactedText),
      );
      position = next.at + next.secret.length;
    }
    const rest = data.subarray(position);
    const held = final ? 0 : this.partialLength(rest);
    released.push(rest.subarray(0, rest.length - held));
    this.pending = Buffer.from(rest.subarray(rest.length - held));
    return Buffer.concat(released);
  }

  /** Length of the longest end of `bytes` that is the beginning of a secret. */
  private partialLength(bytes: Buffer): number {
    let longest = 0;
    for (const secret of this.secrets)
      for (
        let length = Math.min(secret.length - 1, bytes.length);
        length > longest;
        length--
      )
        if (
          bytes
            .subarray(bytes.length - length)
            .equals(secret.subarray(0, length))
        ) {
          longest = length;
          break;
        }
    return longest;
  }
}
