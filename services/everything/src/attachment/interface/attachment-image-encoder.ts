/** A best-effort local PNG format conversion, with cancellation and original-byte fallback. */
export interface AttachmentImageEncoder {
  /** Undefined keeps the original; only smaller, same-resolution WebP bytes may be returned. */
  webp(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined>;
}
