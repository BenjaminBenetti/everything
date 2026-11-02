import type { Readable } from "node:stream";
import type { AttachmentLocation } from "../model/attachment.js";

/** An attachment's file opened for reading, as it is now in the teammate's workspace. */
export interface AttachmentContent {
  readonly size: number;
  readonly stream: Readable;
}

/** A validated complete upload, still private until publish; the record can first save its final path. */
export interface PreparedAttachmentFile {
  readonly location: AttachmentLocation;
  readonly size: number;
  readonly head: Uint8Array;
  readonly encoded: boolean;
}

/**
 * Where attachment bytes are kept: a partial upload out of every teammate's reach, then the complete
 * file at its server-chosen path in the teammate's workspace.
 */
export interface AttachmentFiles {
  /** Create the empty partial file for a new upload; partial files are known by the upload's ID. */
  begin(id: string): Promise<void>;
  /**
   * Append `body` to the partial file, which must hold exactly `offset` bytes, refusing more than
   * `limit` bytes. On any failure, including the caller disconnecting, the partial file is returned
   * to `offset` bytes. Resolves to the number of bytes appended.
   */
  append(
    id: string,
    offset: number,
    body: AsyncIterable<Uint8Array>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<number>;
  /** Read up to `bytes` from the start of the partial file. */
  head(id: string, bytes: number): Promise<Uint8Array>;
  /** Prepare an optional smaller WebP without exposing it in the teammate's workspace. */
  prepare(
    location: AttachmentLocation,
    inputSize: number,
    signal?: AbortSignal,
    encodePng?: boolean,
  ): Promise<PreparedAttachmentFile>;
  /** Roll back an aborted final part; remove only its private encoded candidate. */
  rewind(id: string, offset: number): Promise<void>;
  /** Move the complete partial file to its path in the teammate's workspace. */
  publish(location: AttachmentLocation, encoded?: boolean): Promise<void>;
  /** Remove the partial file; a missing one is ignored. */
  discard(id: string): Promise<void>;
  /** Remove a published file and its folder; a missing one is ignored. */
  remove(location: AttachmentLocation): Promise<void>;
  /** Open a published file, or undefined when it is gone or no longer a regular file. */
  open(location: AttachmentLocation): Promise<AttachmentContent | undefined>;
  /** IDs of uploads whose partial files haven't changed since `before`, a time in milliseconds. */
  partials(before: number): Promise<string[]>;
}
