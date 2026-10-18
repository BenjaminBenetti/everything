/** Uploads raw bytes to the application's API and reads its JSON answer. */
export interface BinaryTransport {
  /** POST a body with its own content type, under the same authentication and safety rules. */
  upload<T>(
    path: string,
    body: Blob,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<T>;
}
