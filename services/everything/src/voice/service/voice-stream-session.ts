import { messageTextMaxLength } from "@everything/conversation-contracts";
import {
  decodeVoiceFrame,
  parseVoiceClientMessage,
  parseVoiceServiceMessage,
  voiceStreamAudio,
  voiceStreamLimits,
  voiceStreamLiveVersion,
  voiceStreamStartFor,
  voiceStreamVersion,
  type VoiceStreamEnd,
  type VoiceStreamErrorCode,
  type VoiceStreamPartial,
  type VoiceStreamReady,
  type VoiceStreamServiceMessage,
  type VoiceStreamVersion,
} from "@everything/conversation-contracts/voice-stream";
import type {
  SpeechStreams,
  StreamChannel,
} from "../interface/speech-streams.js";

/** Deadlines one stream observes. */
export interface StreamTiming {
  /** From connection to the speech service's ready. */
  readonly startTimeoutMs: number;
  /** Longest gap between audio messages while recording. */
  readonly idleTimeoutMs: number;
  /** From end to the final transcript. */
  readonly finalTimeoutMs: number;
  /** From asking the speech service to cancel to its acknowledgement. */
  readonly cleanupTimeoutMs: number;
}

/** The fixed deadlines; the final timeout comes from configuration. */
export const streamTiming = {
  startTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  cleanupTimeoutMs: 10_000,
} as const;

/** Text messages a browser may send: start, end, and cancel. */
const maxControlMessages = 3;

/**
 * Most bytes queued toward the speech service: a full window of audio plus headroom. More means the
 * service isn't reading and the stream fails instead of buffering.
 */
const maxServiceBufferBytes = voiceStreamLimits.windowSamples * 2 + 64 * 1024;

/**
 * Largest service message read: a maximum-length final with every character escaped. The service
 * connection enforces it on the wire; parsing checks it again.
 */
export const maxServiceMessageBytes = messageTextMaxLength * 6 + 256;

/**
 * Bytes queued toward the browser beyond which a partial transcript is skipped rather than queued.
 * Each partial replaces the last and the final replaces them all, so a slow browser only sees fewer.
 */
const maxBrowserPartialBufferBytes = 256 * 1024;

/**
 * Where a stream is:
 * - `awaitingStart`: connected, no start yet.
 * - `connecting`: connecting to the speech service.
 * - `starting`: start sent, waiting for ready.
 * - `streaming`: audio flows, acknowledged by the service.
 * - `ending`: end sent, waiting for the final transcript.
 * - `cancelling`: cancel sent, waiting for the service to confirm its work stopped.
 * - `done`: finished; nothing more is sent or accepted.
 */
type Stage =
  | "awaitingStart"
  | "connecting"
  | "starting"
  | "streaming"
  | "ending"
  | "cancelling"
  | "done";

/**
 * Relays one browser stream to the speech service, validating both sides. It enforces the frame
 * size, consecutive sequences, the sample and message limits, the acknowledgement window, and the
 * end barrier, so the service never sees an invalid stream and the browser never sees anything but
 * the allowlisted messages. On cancellation or a browser disconnect it asks the service to cancel
 * and waits, within a deadline, for confirmation; a closed connection is never taken as proof that
 * the service's work stopped. `finished` runs exactly once, when nothing more will be sent to the
 * service.
 *
 * Each side keeps its own agreed version. A version 2 browser streams version 2 to a service that
 * speaks it, and receives its partial transcripts; with a version 1 service it gets only the final,
 * as a version 1 browser always does.
 */
export class VoiceStreamSession {
  private stage: Stage = "awaitingStart";
  private service: StreamChannel | null = null;
  private serviceVersion: VoiceStreamVersion = voiceStreamVersion;
  private partialRevision = 0;
  private readonly connecting = new AbortController();
  private ready: VoiceStreamReady | null = null;
  private browserOpen = true;
  private controls = 0;
  private nextSequence = 0;
  private totalSamples = 0;
  private acknowledged = -1;
  private unacknowledgedSamples = 0;
  private readonly frameSamples: number[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private ended = false;

  // ===========================================
  // Construction
  // ===========================================

  /** Start the start and lifetime deadlines for a browser that has just connected with `version`. */
  constructor(
    private readonly browser: StreamChannel,
    private readonly streams: SpeechStreams,
    private readonly timing: StreamTiming,
    private readonly finished: () => void,
    private readonly browserVersion: VoiceStreamVersion = voiceStreamVersion,
  ) {
    this.schedule("start", timing.startTimeoutMs);
    // The whole stream is bounded, whatever arrives: startup, a full recording, finalizing, cleanup.
    this.schedule(
      "lifetime",
      timing.startTimeoutMs +
        (voiceStreamLimits.maxSamples / voiceStreamAudio.sampleRate) * 1000 +
        timing.idleTimeoutMs +
        timing.finalTimeoutMs +
        timing.cleanupTimeoutMs,
    );
  }

  // ===========================================
  // Browser events
  // ===========================================

  /** Take one message from the browser. */
  fromBrowser(data: Uint8Array, binary: boolean): void {
    if (this.stage === "done" || this.stage === "cancelling") return;
    if (binary) return this.audio(data);
    if (++this.controls > maxControlMessages)
      return this.fail("INVALID_MESSAGE");
    const message = parseVoiceClientMessage(Buffer.from(data).toString("utf8"));
    if (!message) return this.fail("INVALID_MESSAGE");
    switch (message.type) {
      case "start":
        // The start must name the version the connection agreed on.
        return message.version === this.browserVersion
          ? this.start()
          : this.fail("INVALID_MESSAGE");
      case "end":
        return this.end(message);
      case "cancel":
        return this.cancel();
    }
  }

  /** The browser disconnected; whatever the service is doing is cancelled. */
  browserClosed(): void {
    this.browserOpen = false;
    if (this.stage !== "done" && this.stage !== "cancelling") this.cancel();
  }

  /** Stop the stream because the gateway is shutting down. */
  shutdown(): void {
    if (this.stage !== "done" && this.stage !== "cancelling")
      this.fail("UNAVAILABLE");
  }

  // ===========================================
  // Service events
  // ===========================================

  /** Take one message from the speech service. */
  private fromService(data: string | Uint8Array): void {
    if (this.stage === "done") return;
    const message =
      typeof data === "string"
        ? parseVoiceServiceMessage(data, {
            maxText: messageTextMaxLength,
            maxBytes: maxServiceMessageBytes,
            version: this.serviceVersion,
          })
        : null;
    if (!message) return this.serviceFault();
    this.serviceMessage(message);
  }

  /** Act on a valid service message in the current stage. */
  private serviceMessage(message: VoiceStreamServiceMessage): void {
    switch (message.type) {
      case "ready":
        if (this.stage !== "starting") return this.serviceFault();
        this.ready = message;
        this.stage = "streaming";
        this.clear("start");
        this.schedule("idle", this.timing.idleTimeoutMs);
        return this.toBrowser({ ...message, version: this.browserVersion });
      case "ack":
        if (this.stage === "cancelling") return;
        if (this.stage !== "streaming" && this.stage !== "ending")
          return this.serviceFault();
        return this.acknowledge(message.sequence);
      case "partial":
        if (this.stage === "cancelling") return;
        if (this.stage !== "streaming" && this.stage !== "ending")
          return this.serviceFault();
        return this.partial(message);
      case "final":
        if (this.stage === "cancelling") return this.complete();
        if (this.stage !== "ending") return this.serviceFault();
        this.toBrowser(message);
        return this.complete();
      case "cancelled":
        if (this.stage !== "cancelling") return this.serviceFault();
        this.toBrowser(message);
        return this.complete();
      case "error":
        if (this.stage !== "cancelling") this.toBrowser(message);
        return this.complete();
    }
  }

  /** The service connection closed; unless the stream had finished, the browser learns it failed. */
  private serviceClosed(): void {
    if (this.stage === "done") return;
    if (this.stage !== "cancelling")
      this.toBrowser({ type: "error", code: "UNAVAILABLE" });
    this.complete();
  }

  /** The service broke the protocol; nothing it sends is trusted further. */
  private serviceFault(): void {
    if (this.stage === "cancelling") return this.complete();
    this.fail("UNAVAILABLE");
  }

  // ===========================================
  // Stream steps
  // ===========================================

  /** Connect to the service and send start. */
  private start(): void {
    if (this.stage !== "awaitingStart") return this.fail("INVALID_MESSAGE");
    this.stage = "connecting";
    this.streams
      .connect(
        {
          message: (data) => this.fromService(data),
          closed: () => this.serviceClosed(),
        },
        this.connecting.signal,
      )
      .then(
        (service) => {
          if (this.stage !== "connecting") return service.close();
          this.service = service;
          this.stage = "starting";
          this.serviceVersion =
            this.browserVersion === voiceStreamLiveVersion && service.live
              ? voiceStreamLiveVersion
              : voiceStreamVersion;
          service.send(
            JSON.stringify(voiceStreamStartFor(this.serviceVersion)),
          );
        },
        () => {
          if (this.stage === "connecting") this.fail("UNAVAILABLE");
        },
      );
  }

  /** Validate one audio message and forward it unchanged. */
  private audio(data: Uint8Array): void {
    if (this.stage !== "streaming" || !this.ready || !this.service)
      return this.fail("INVALID_MESSAGE");
    const frame = decodeVoiceFrame(data);
    if (!frame || frame.samples > this.ready.maxFrameSamples)
      return this.fail("INVALID_AUDIO");
    if (frame.sequence !== this.nextSequence)
      return this.fail("INVALID_SEQUENCE");
    if (
      this.nextSequence >= voiceStreamLimits.maxMessages ||
      this.totalSamples + frame.samples > this.ready.maxSamples
    )
      return this.fail("TOO_LONG");
    if (
      this.unacknowledgedSamples + frame.samples > this.ready.windowSamples ||
      this.service.bufferedAmount > maxServiceBufferBytes
    )
      return this.fail("BACKPRESSURE");
    this.frameSamples.push(frame.samples);
    this.nextSequence++;
    this.totalSamples += frame.samples;
    this.unacknowledgedSamples += frame.samples;
    this.schedule("idle", this.timing.idleTimeoutMs);
    this.service.send(data);
  }

  /** Credit acknowledged audio and pass the acknowledgement on; it may never go backwards or ahead. */
  private acknowledge(sequence: number): void {
    if (sequence < this.acknowledged || sequence >= this.nextSequence)
      return this.serviceFault();
    if (sequence === this.acknowledged) return;
    for (let index = this.acknowledged + 1; index <= sequence; index++)
      this.unacknowledgedSamples -= this.frameSamples[index]!;
    this.acknowledged = sequence;
    this.toBrowser({ type: "ack", sequence });
  }

  /**
   * Pass a partial transcript on; revisions must only increase. One is skipped while the browser
   * isn't reading, rather than queued, since the next one or the final replaces it.
   */
  private partial(message: VoiceStreamPartial): void {
    if (message.revision <= this.partialRevision) return this.serviceFault();
    this.partialRevision = message.revision;
    if (this.browser.bufferedAmount <= maxBrowserPartialBufferBytes)
      this.toBrowser(message);
  }

  /** Pass end on once it matches every audio message received; the final must follow. */
  private end(message: VoiceStreamEnd): void {
    if (this.stage !== "streaming" || !this.service)
      return this.fail("INVALID_MESSAGE");
    if (message.sequence !== this.nextSequence)
      return this.fail("INVALID_SEQUENCE");
    if (message.totalSamples !== this.totalSamples)
      return this.fail("INVALID_AUDIO");
    this.stage = "ending";
    this.clear("idle");
    this.schedule("final", this.timing.finalTimeoutMs);
    this.service.send(JSON.stringify(message));
  }

  /** Ask the service to cancel and wait, within the cleanup deadline, for its confirmation. */
  private cancel(): void {
    if (this.stage === "awaitingStart" || this.stage === "connecting") {
      // No service work exists yet.
      this.connecting.abort();
      this.toBrowser({ type: "cancelled" });
      return this.complete();
    }
    this.beginCancelling();
  }

  /** Report a failure to the browser, then cancel the service's work as for a cancellation. */
  private fail(code: VoiceStreamErrorCode): void {
    if (this.stage === "done" || this.stage === "cancelling") return;
    this.toBrowser({ type: "error", code });
    this.closeBrowser();
    if (this.stage === "awaitingStart" || this.stage === "connecting") {
      this.connecting.abort();
      return this.complete();
    }
    this.beginCancelling();
  }

  /** Send cancel to the service and wait for it to confirm, or for the cleanup deadline. */
  private beginCancelling(): void {
    this.stage = "cancelling";
    for (const name of ["start", "idle", "final"]) this.clear(name);
    this.service?.send(JSON.stringify({ type: "cancel" }));
    this.schedule("cleanup", this.timing.cleanupTimeoutMs);
  }

  /** Finish: close both connections, stop every deadline, and hand back the stream's places. */
  private complete(): void {
    if (this.stage === "done") return;
    this.stage = "done";
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.service?.close();
    this.closeBrowser();
    if (!this.ended) {
      this.ended = true;
      this.finished();
    }
  }

  // ===========================================
  // Helpers
  // ===========================================

  /** Send a message to the browser while it is connected. */
  private toBrowser(message: VoiceStreamServiceMessage): void {
    if (this.browserOpen) this.browser.send(JSON.stringify(message));
  }

  /** Close the browser connection once. */
  private closeBrowser(): void {
    if (!this.browserOpen) return;
    this.browserOpen = false;
    this.browser.close();
  }

  /** Start or restart a named deadline. */
  private schedule(name: string, delayMs: number): void {
    this.clear(name);
    this.timers.set(
      name,
      setTimeout(() => this.expired(name), delayMs),
    );
  }

  /** Stop a named deadline. */
  private clear(name: string): void {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
  }

  /** A deadline passed: cleanup gives up waiting; anything else fails the stream. */
  private expired(name: string): void {
    this.timers.delete(name);
    if (name === "cleanup") return this.complete();
    this.fail("TIMEOUT");
  }
}
