import {
  VoiceCapacityError,
  VoiceUnavailableError,
} from "../error/voice-errors.js";
import type { VoiceAdmissionSettings } from "../model/voice-settings.js";

/** Ends one admitted transcription; calling it again has no effect. */
export type Release = () => void;

/** A transcription waiting for a free slot. */
interface Waiter {
  admit(release: Release): void;
  refuse(error: Error): void;
}

/**
 * Admits a bounded number of transcriptions at once and queues a bounded number more, in arrival
 * order. A queued transcription leaves the queue when its wait deadline passes, its caller goes
 * away, or the service closes, so no recording is held indefinitely.
 */
export class VoiceAdmission {
  private running = 0;
  private readonly waiting: Waiter[] = [];
  private closed = false;

  /** Apply the configured limits. */
  constructor(private readonly settings: VoiceAdmissionSettings) {}

  /** Wait for a slot, or fail at once when the queue is full. */
  enter(signal: AbortSignal): Promise<Release> {
    if (this.closed || signal.aborted)
      return Promise.reject(new VoiceUnavailableError());
    if (this.running < this.settings.concurrency) {
      this.running++;
      return Promise.resolve(this.release());
    }
    if (this.waiting.length >= this.settings.queueLimit)
      return Promise.reject(new VoiceCapacityError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        admit: (release) => {
          leave();
          resolve(release);
        },
        refuse: (error) => {
          leave();
          reject(error);
        },
      };
      const timer = setTimeout(
        () => this.remove(waiter, new VoiceCapacityError()),
        this.settings.queueTimeoutMs,
      );
      const onAbort = (): void =>
        this.remove(waiter, new VoiceUnavailableError());
      /** Stop watching the deadline and the caller once the wait ends. */
      const leave = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  /** Refuse every waiting and future transcription. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0))
      waiter.refuse(new VoiceUnavailableError());
  }

  /** Hand the slot to the next waiter, or free it. */
  private release(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.admit(this.release());
      else this.running--;
    };
  }

  /** Take a waiter out of the queue and refuse it. */
  private remove(waiter: Waiter, error: Error): void {
    const index = this.waiting.indexOf(waiter);
    if (index < 0) return;
    this.waiting.splice(index, 1);
    waiter.refuse(error);
  }
}
