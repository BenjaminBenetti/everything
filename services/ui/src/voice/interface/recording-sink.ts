/**
 * Receives a recording's encoded chunks in order while it is captured. Chunks after the first are
 * not standalone files. A batch transport buffers them for one upload; a live transport could
 * process them as they arrive.
 */
export interface RecordingSink {
  write(chunk: Blob): void;
  /** Drop everything received. */
  discard(): void;
}
