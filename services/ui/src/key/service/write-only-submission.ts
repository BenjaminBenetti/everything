/** Where a write-only submission stands; it never includes the secret that was sent. */
export type SubmissionState<T> =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "succeeded"; readonly result: T };

/**
 * Hold a secret draft and send it, one attempt at a time, without keeping it anywhere else. The
 * request is started synchronously from the current draft, so no pending continuation, shared
 * cache, or stored callback holds the value. The draft is erased when an attempt succeeds and when
 * the form closes; after a failure it stays only in this object, so the person can try again.
 */
export class WriteOnlySubmission<T> {
  // ===========================================
  // State
  // ===========================================

  #draft = "";
  #state: SubmissionState<T> = { status: "idle" };
  /** Increases with every attempt and on close, so a late answer to an earlier one is ignored. */
  #attempt = 0;
  #closed = false;
  #version = 0;
  readonly #listeners = new Set<() => void>();

  // ===========================================
  // Reading
  // ===========================================

  /** The secret being typed, for the form's own field only. */
  get draft(): string {
    return this.#draft;
  }

  /** Where the latest attempt stands. */
  get state(): SubmissionState<T> {
    return this.#state;
  }

  /** Changes whenever the draft or state does, for React's external store. */
  readonly version = (): number => this.#version;

  /** Call the listener after every change; returns a function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  // ===========================================
  // Changes
  // ===========================================

  /** Replace the draft as the person types or reads a file. */
  edit(draft: string): void {
    if (this.#closed) return;
    this.#draft = draft;
    this.#changed();
  }

  /**
   * Start one attempt with the current draft. `send` receives the draft and must build its request
   * before returning, and isn't kept; the returned promise settles with the attempt's state.
   */
  submit(send: (secret: string) => Promise<T>): Promise<SubmissionState<T>> {
    if (this.#closed || this.#state.status === "pending")
      return Promise.resolve(this.#state);
    const attempt = ++this.#attempt;
    let sending: Promise<T>;
    try {
      sending = send(this.#draft);
    } catch (error) {
      sending = Promise.reject(error);
    }
    this.#state = { status: "pending" };
    this.#changed();
    return this.#settle(sending, attempt);
  }

  /** Let a reopened form use this object again, as React does when it remounts an effect. */
  open(): void {
    this.#closed = false;
  }

  /** Erase the draft and ignore any attempt still in flight; nothing is kept after closing. */
  close(): void {
    this.#closed = true;
    this.#attempt++;
    this.#draft = "";
    if (this.#state.status === "pending") this.#state = { status: "idle" };
    this.#changed();
  }

  // ===========================================
  // Settling
  // ===========================================

  /** Record an attempt's outcome unless a newer attempt or a close came first. */
  async #settle(
    sending: Promise<T>,
    attempt: number,
  ): Promise<SubmissionState<T>> {
    try {
      const result = await sending;
      if (attempt === this.#attempt) {
        this.#draft = "";
        this.#state = { status: "succeeded", result };
      }
    } catch (error) {
      if (attempt === this.#attempt) this.#state = { status: "failed", error };
    }
    this.#changed();
    return this.#state;
  }

  /** Notify listeners of a change. */
  #changed(): void {
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }
}
