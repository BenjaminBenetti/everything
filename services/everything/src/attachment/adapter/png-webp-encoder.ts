import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  imageDimensions,
  imageMediaType,
} from "../../workspace/model/image-format.js";
import { attachmentLimits } from "../model/attachment.js";
import { staticPng } from "../model/static-png.js";
import type { AttachmentImageEncoder } from "../interface/attachment-image-encoder.js";

/** A single local operation, no waiting queue, no provider call and no image resizing. */
export class PngWebpEncoder implements AttachmentImageEncoder {
  private active = false;

  /** The deadline covers startup, decode and encode, unlike a codec-only timeout. */
  constructor(private readonly timeoutMs = 10_000) {}

  /** Busy/unsupported/no-benefit/failed work preserves original bytes; aborts remain resumable. */
  async webp(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    signal?.throwIfAborted();
    if (bytes.byteLength > attachmentLimits.maxFileBytes || this.active)
      return undefined;
    const dimensions = staticPng(bytes);
    if (!dimensions) return undefined;
    this.active = true;
    try {
      const output = await this.encode(bytes, signal);
      signal?.throwIfAborted();
      if (
        !output ||
        output.length >= bytes.byteLength ||
        imageMediaType(output) !== "image/webp"
      )
        return undefined;
      const size = imageDimensions(output, "image/webp");
      return size?.width === dimensions.width &&
        size.height === dimensions.height
        ? output
        : undefined;
    } finally {
      this.active = false;
    }
  }

  /** Kill the isolated codec process on abort, timeout or excessive output; never leave native work running. */
  private encode(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const worker = fileURLToPath(
      new URL("../worker/png-webp-worker" + extension, import.meta.url),
    );
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--max-old-space-size=64", worker],
        {
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      let parts: Buffer[] = [],
        size = 0,
        stopped = false;
      const stop = () => {
        stopped = true;
        parts = [];
        child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, this.timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      child.once("error", stop);
      child.stdin.on("error", () => undefined);
      child.stdout.on("data", (part: Buffer) => {
        if (stopped) return;
        size += part.length;
        if (size >= bytes.byteLength) stop();
        else parts.push(part);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve(
          !stopped && code === 0 && size > 0
            ? Buffer.concat(parts, size)
            : undefined,
        );
      });
      child.stdin.end(bytes);
      if (signal?.aborted) stop();
    });
  }
}
