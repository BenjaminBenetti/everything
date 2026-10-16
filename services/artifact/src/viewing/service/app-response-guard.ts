import type { IncomingHttpHeaders } from "node:http";
import { PassThrough, Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { AppResponseBlockedError } from "../error/app-response-blocked-error.js";
import { SecretMatcher } from "./secret-matcher.js";

/** Inspected headers and a stream that withholds matching credentials. */
export interface GuardedResponse {
  readonly headers: IncomingHttpHeaders;
  readonly stream: Readable;
}

/** Decode and inspect HTTP responses before their bytes reach a viewer. */
export class AppResponseGuard {
  // ===========================================
  // Operations
  // ===========================================

  /** Inspect all headers and prime the body so immediate failures can return a clean 502. */
  async inspect(
    source: Readable,
    headers: IncomingHttpHeaders,
    status: number,
    method: string,
    secrets: readonly string[],
  ): Promise<GuardedResponse> {
    const matcher = new SecretMatcher(secrets);
    for (const [name, value] of Object.entries(headers)) {
      matcher.check(Buffer.from(name));
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry !== undefined) matcher.check(Buffer.from(entry));
      }
    }
    if (
      status === 206 ||
      status === 304 ||
      headers["content-range"] !== undefined
    ) {
      throw new AppResponseBlockedError();
    }
    const inspectedHeaders: IncomingHttpHeaders = {
      ...headers,
      "cache-control": "no-store",
    };
    for (const name of [
      "content-length",
      "transfer-encoding",
      "trailer",
      "etag",
      "last-modified",
      "accept-ranges",
      "content-md5",
      "digest",
    ]) {
      delete inspectedHeaders[name];
    }
    const bodyless = method === "HEAD" || status === 204 || status === 205;
    const encodings = bodyless
      ? []
      : (headers["content-encoding"] ?? "identity")
          .split(",")
          .map((coding) => coding.trim().toLowerCase())
          .reverse();
    if (encodings.length > 3) throw new AppResponseBlockedError();
    const decoders: Transform[] = [];
    for (const encoding of encodings) {
      switch (encoding) {
        case "identity":
          break;
        case "gzip":
        case "x-gzip":
          decoders.push(createGunzip());
          break;
        case "deflate":
          decoders.push(createInflate());
          break;
        case "br":
          decoders.push(createBrotliDecompress());
          break;
        default:
          throw new AppResponseBlockedError();
      }
    }
    let decoded = source;
    if (decoders.length) {
      decoded = new PassThrough();
      // Observe pipeline failures immediately; the scanner exposes only a sanitized error.
      void pipeline([source, ...decoders, decoded]).catch(() => {});
      delete inspectedHeaders["content-encoding"];
    }
    const iterator = matcher.scan(decoded);
    let first: IteratorResult<Buffer>;
    try {
      first = await iterator.next();
    } catch {
      decoded.destroy();
      source.destroy();
      throw new AppResponseBlockedError();
    }
    /** Continue the primed scan with backpressure and close upstream when a viewer disconnects. */
    async function* remaining(): AsyncGenerator<Buffer> {
      try {
        if (!first.done) yield first.value;
        yield* iterator;
      } finally {
        await iterator.return(undefined);
        decoded.destroy();
        source.destroy();
      }
    }
    const stream = Readable.from(remaining(), { objectMode: false });
    // A response can be canceled before its generator starts.
    stream.once("close", () => {
      decoded.destroy();
      source.destroy();
    });
    return { headers: inspectedHeaders, stream };
  }
}
