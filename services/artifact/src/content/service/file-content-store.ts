import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { contentHashPattern } from "@everything/artifact-contracts";
import type { ContentStore } from "../interface/content-store.js";
import {
  ContentMismatchError,
  ContentNotFoundError,
  ContentTooLargeError,
} from "../error/content-errors.js";

/** Accepted content addresses. */
const contentHash = new RegExp(contentHashPattern);

/** Pass content through, failing once more than `maxSize` bytes have passed. */
function limit(maxSize: number): Transform {
  let size = 0;
  return new Transform({
    /** Count each chunk before passing it on. */
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxSize) return callback(new ContentTooLargeError(maxSize));
      callback(null, chunk);
    },
  });
}

/** Keeps each piece of content in a file named by its hash, under one root directory. */
export class FileContentStore implements ContentStore {
  // ===========================================
  // State
  // ===========================================

  private readonly root: string;

  // ===========================================
  // Construction
  // ===========================================

  /** Use the given root, typically a persistent volume. */
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Check each hash against the stored files. */
  async missing(hashes: readonly string[]): Promise<string[]> {
    const unique = [...new Set(hashes)];
    const present = await Promise.all(unique.map((hash) => this.exists(hash)));
    return unique.filter((_hash, index) => !present[index]);
  }

  /** Write to a temporary file while hashing, then move it into place only if the hash matches. */
  async write(hash: string, content: Readable, maxSize: number): Promise<void> {
    const target = this.location(hash);
    if (await this.exists(hash)) {
      await pipeline(
        content,
        limit(maxSize),
        new Writable({ write: (_chunk, _encoding, done) => done() }),
      );
      return;
    }
    const temporary = path.join(this.root, "incoming", randomUUID());
    await mkdir(path.dirname(temporary), { recursive: true });
    const digest = createHash("sha256");
    const hashing = new Transform({
      /** Hash each chunk on its way to the temporary file. */
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        content,
        limit(maxSize),
        hashing,
        createWriteStream(temporary),
      );
      if (digest.digest("hex") !== hash) throw new ContentMismatchError();
      await mkdir(path.dirname(target), { recursive: true });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Open stored content after confirming it exists. */
  async open(hash: string): Promise<Readable> {
    if (!(await this.exists(hash))) throw new ContentNotFoundError();
    return createReadStream(this.location(hash));
  }

  // ===========================================
  // Storage layout
  // ===========================================

  /** Whether content is stored under the hash. */
  private async exists(hash: string): Promise<boolean> {
    try {
      await access(this.location(hash));
      return true;
    } catch {
      return false;
    }
  }

  /** Spread files over subdirectories named by the hash's first two characters. */
  private location(hash: string): string {
    if (!contentHash.test(hash)) throw new ContentNotFoundError();
    return path.join(this.root, "content", hash.slice(0, 2), hash);
  }
}
