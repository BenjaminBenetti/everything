import { AppResponseBlockedError } from "../error/app-response-blocked-error.js";

/** Match literal credentials and common representations without retaining a whole response. */
export class SecretMatcher {
  private readonly patterns: readonly Buffer[];

  // ===========================================
  // Construction
  // ===========================================

  /** Cover text, JSON escapes, URL encoding, base64, and UTF-16 text. */
  constructor(secrets: readonly string[]) {
    this.patterns = [...new Set(secrets.filter(Boolean))].flatMap((secret) => {
      const bytes = Buffer.from(secret);
      const unicode = secret
        .split("")
        .map(
          (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
        )
        .join("");
      const texts = new Set([
        secret,
        JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret),
        bytes.toString("base64"),
        bytes.toString("base64url"),
        unicode,
      ]);
      return [
        ...[...texts].map((text) => Buffer.from(text)),
        Buffer.from(secret, "utf16le"),
        Buffer.from(secret, "utf16le").swap16(),
      ];
    });
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Reject a complete match without including any matched bytes in the error. */
  check(bytes: Buffer): void {
    if (this.patterns.some((pattern) => bytes.includes(pattern))) {
      throw new AppResponseBlockedError();
    }
  }

  /** Stream safe bytes, retaining only a suffix that could become a secret in the next chunk. */
  async *scan(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    let pending: Buffer = Buffer.alloc(0);
    try {
      for await (const chunk of source) {
        const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        this.check(bytes);
        let retained = 0;
        for (const pattern of this.patterns) {
          for (
            let size = Math.min(pattern.length - 1, bytes.length);
            size > retained;
            size--
          ) {
            if (
              bytes
                .subarray(bytes.length - size)
                .equals(pattern.subarray(0, size))
            ) {
              retained = size;
              break;
            }
          }
        }
        const safeLength = bytes.length - retained;
        // Copy the small suffix so it cannot keep an arbitrarily large chunk alive.
        pending = Buffer.from(bytes.subarray(safeLength));
        if (safeLength) yield bytes.subarray(0, safeLength);
      }
      if (pending.length) yield pending;
    } catch {
      throw new AppResponseBlockedError();
    }
  }
}
