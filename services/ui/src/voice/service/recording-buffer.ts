import type { RecordedAudio } from "../interface/voice-client.js";
import type { RecordingSink } from "../interface/recording-sink.js";

/** Keeps a recording's chunks for one upload after it ends, as the batch transport needs. */
export class RecordingBuffer implements RecordingSink {
  private chunks: Blob[] = [];

  /** Keep the next chunk. */
  write(chunk: Blob): void {
    this.chunks.push(chunk);
  }

  /** Drop every chunk. */
  discard(): void {
    this.chunks = [];
  }

  /** Join the chunks into one recording and let go of them, or return null when there are none. */
  take(type: string): RecordedAudio | null {
    const chunks = this.chunks;
    this.chunks = [];
    return chunks.length ? { blob: new Blob(chunks, { type }), type } : null;
  }
}
