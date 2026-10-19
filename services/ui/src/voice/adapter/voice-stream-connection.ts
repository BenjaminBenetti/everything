import { messageTextMaxLength } from "@everything/conversation-contracts";
import {
  encodeVoiceFrame,
  parseVoiceServiceMessage,
  voiceStreamLimits,
  voiceStreamStart,
  type VoiceStreamErrorCode,
  type VoiceStreamReady,
} from "@everything/conversation-contracts/voice-stream";
import type { PcmSink } from "../interface/pcm-capture.js";
import { VoiceInputError } from "../model/voice-input-error.js";
import type { VoiceNotice } from "../model/voice-notice.js";

/** Most samples waiting to be sent, while connecting or while the window is full: 4 seconds. */
const maxPendingSamples = 64_000;

/** Bytes queued in the WebSocket beyond which sending pauses until the network catches up. */
const maxBufferedBytes = 128 * 1024;

/** How often sending retries while the WebSocket's queue is full. */
const bufferRetryMs = 20;

/** How long connecting may take before the stream counts as unavailable. */
const readyTimeoutMs = 10_000;

/** Largest message read from the gateway: a maximum-length final with every character escaped. */
const maxMessageBytes = messageTextMaxLength * 6 + 256;

/** The outcome each protocol error code reports. */
const errorNotices: Readonly<Record<VoiceStreamErrorCode, VoiceNotice>> = {
  INVALID_MESSAGE: "failed",
  INVALID_SEQUENCE: "failed",
  INVALID_AUDIO: "failed",
  TOO_LONG: "tooLarge",
  BUSY: "busy",
  UNAVAILABLE: "unavailable",
  BACKPRESSURE: "fellBehind",
  TIMEOUT: "timedOut",
};

/** Options for one stream. */
export interface VoiceStreamConnectionOptions {
  /** Longest to wait for the final transcript after end. */
  readonly finalTimeoutMs: number;
  /** The stream failed while no finish was pending. */
  onFailure(error: VoiceInputError): void;
}

/**
 * One voice stream to the gateway, speaking protocol v1. Frames are sent as they arrive within the
 * acknowledgement window; while connecting or while the window is full they wait in a bounded
 * queue, and a full queue fails the recording rather than dropping audio. End is sent only after
 * every frame, with the counted totals, and only a final from the service is a transcript.
 */
export class VoiceStreamConnection implements PcmSink {
  private socket: WebSocket | null = null;
  private ready: VoiceStreamReady | null = null;
  private stage: "connecting" | "streaming" | "ending" | "done" = "connecting";
  private readonly pending: Int16Array[] = [];
  private pendingSamples = 0;
  private nextSequence = 0;
  private sentSamples = 0;
  private acknowledged = -1;
  private unacknowledgedSamples = 0;
  private readonly frameSamples: number[] = [];
  private expectedSamples: number | null = null;
  private endSent = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private finishDeadline: ReturnType<typeof setTimeout> | undefined;
  private finishing: Promise<string> | null = null;
  private finished:
    | { resolve(text: string): void; reject(error: VoiceInputError): void }
    | undefined;

  /** Bind the gateway's stream URL for a teammate. */
  constructor(
    private readonly url: string,
    private readonly options: VoiceStreamConnectionOptions,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Connect and send start; audio written meanwhile waits in the bounded queue. */
  open(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    this.deadline = setTimeout(() => this.fail("unavailable"), readyTimeoutMs);
    socket.onopen = () => socket.send(JSON.stringify(voiceStreamStart));
    socket.onmessage = (event: MessageEvent) =>
      typeof event.data === "string"
        ? this.receive(event.data)
        : this.fail("failed");
    socket.onerror = () => undefined;
    // A refused upgrade (auth, ownership, busy, unavailable) and a dropped stream both end here.
    socket.onclose = () => this.fail("unavailable");
  }

  /** Take the next frame; throws when the queue would pass its bound. */
  write(samples: Int16Array): void {
    if (this.stage === "done") return;
    if (this.stage === "ending") throw new VoiceInputError("failed");
    if (this.pendingSamples + samples.length > maxPendingSamples)
      throw new VoiceInputError("fellBehind");
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    this.drain();
  }

  /**
   * Send end once every frame is out, then wait for the final transcript. `samples` is what the
   * capture produced; it must match what was sent, or the recording is incomplete. One deadline
   * covers the whole path, waiting for ready, sending queued frames as credit allows, and the
   * final, so the result always settles. Calling it again returns the same result.
   */
  finish(samples: number): Promise<string> {
    if (this.finishing) return this.finishing;
    if (this.stage === "done")
      return Promise.reject(new VoiceInputError("unavailable"));
    this.expectedSamples = samples;
    this.finishing = new Promise((resolve, reject) => {
      this.finished = { resolve, reject };
      this.finishDeadline = setTimeout(
        () => this.fail("timedOut"),
        this.options.finalTimeoutMs,
      );
      if (this.stage === "streaming") this.beginEnding();
      // While connecting, ending begins when ready arrives.
    });
    return this.finishing;
  }

  /**
   * Abandon the stream; later messages are ignored. A pending finish settles as cancelled, which
   * reports nothing and inserts nothing. Calling it again has no effect.
   */
  cancel(): void {
    if (this.stage === "done") return;
    const socket = this.socket;
    const finished = this.finished;
    this.stop();
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "cancel" }));
      // The gateway waits for the service to confirm; this side needs nothing more.
      socket.close(1000);
    } else socket?.close();
    finished?.reject(new VoiceInputError("cancelled"));
  }

  // ===========================================
  // Sending
  // ===========================================

  /** Send queued frames while the window and the WebSocket's queue allow, then end when due. */
  private drain(): void {
    const socket = this.socket;
    if (!this.ready || !socket || this.stage === "done") return;
    while (this.pending.length) {
      const next = this.pending[0]!;
      if (this.unacknowledgedSamples + next.length > this.ready.windowSamples)
        return;
      if (socket.bufferedAmount > maxBufferedBytes) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.drain(), bufferRetryMs);
        return;
      }
      this.pending.shift();
      this.pendingSamples -= next.length;
      if (
        this.nextSequence >= voiceStreamLimits.maxMessages ||
        this.sentSamples + next.length > this.ready.maxSamples
      )
        return this.fail("tooLarge");
      socket.send(encodeVoiceFrame(this.nextSequence, next));
      this.frameSamples.push(next.length);
      this.nextSequence++;
      this.sentSamples += next.length;
      this.unacknowledgedSamples += next.length;
    }
    if (this.stage === "ending" && !this.endSent) this.sendEnd();
  }

  /** Start ending: remaining frames drain first, then end follows. */
  private beginEnding(): void {
    this.stage = "ending";
    this.drain();
  }

  /** Send end with the counted totals, once they match the capture's. */
  private sendEnd(): void {
    if (this.sentSamples !== this.expectedSamples)
      return this.fail("fellBehind");
    this.endSent = true;
    this.socket?.send(
      JSON.stringify({
        type: "end",
        sequence: this.nextSequence,
        totalSamples: this.sentSamples,
      }),
    );
  }

  // ===========================================
  // Receiving
  // ===========================================

  /** Act on one gateway message. */
  private receive(text: string): void {
    if (this.stage === "done") return;
    const message = parseVoiceServiceMessage(text, {
      maxText: messageTextMaxLength,
      maxBytes: maxMessageBytes,
    });
    if (!message) return this.fail("failed");
    switch (message.type) {
      case "ready":
        if (this.ready) return this.fail("failed");
        this.ready = message;
        clearTimeout(this.deadline);
        if (this.stage === "connecting")
          this.stage = this.finished ? "ending" : "streaming";
        return this.drain();
      case "ack": {
        const { sequence } = message;
        if (sequence < this.acknowledged || sequence >= this.nextSequence)
          return this.fail("failed");
        for (let index = this.acknowledged + 1; index <= sequence; index++)
          this.unacknowledgedSamples -= this.frameSamples[index]!;
        this.acknowledged = Math.max(this.acknowledged, sequence);
        return this.drain();
      }
      case "final": {
        if (!this.endSent) return this.fail("failed");
        const finished = this.finished;
        this.stop();
        this.socket?.close(1000);
        return finished?.resolve(message.text);
      }
      case "cancelled":
        return this.fail("failed");
      case "error":
        return this.fail(errorNotices[message.code]);
    }
  }

  // ===========================================
  // Ending
  // ===========================================

  /** End with an outcome: a pending finish rejects with it, otherwise the owner is told. */
  private fail(notice: VoiceNotice): void {
    if (this.stage === "done") return;
    const finished = this.finished;
    const socket = this.socket;
    this.stop();
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "cancel" }));
      socket.close();
    }
    const error = new VoiceInputError(notice);
    if (finished) finished.reject(error);
    else this.options.onFailure(error);
  }

  /** Stop everything, drop queued audio, and detach from the socket so late events do nothing. */
  private stop(): void {
    this.stage = "done";
    this.finished = undefined;
    clearTimeout(this.retryTimer);
    clearTimeout(this.deadline);
    clearTimeout(this.finishDeadline);
    this.pending.length = 0;
    this.pendingSamples = 0;
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
    }
  }
}
