/** A connection carrying stream messages: JSON text, or binary audio. */
export interface StreamChannel {
  /** Queue a message; ignored once the connection has closed. */
  send(message: string | Uint8Array): void;
  /** Close the connection; calling it again has no effect. */
  close(): void;
  /** Bytes queued for sending but not yet written to the network. */
  readonly bufferedAmount: number;
}

/** Events from a connection to the speech service. */
export interface StreamListener {
  message(data: string | Uint8Array): void;
  closed(): void;
}

/** An open connection to the speech service. */
export interface SpeechStreamChannel extends StreamChannel {
  /** Whether the service said, while upgrading, that it speaks the version with partial transcripts. */
  readonly live: boolean;
}

/** Opens connections to the operator's streaming speech service, the only place streams go. */
export interface SpeechStreams {
  /** Connect, resolving once open; rejects when the service can't be reached or `signal` aborts. */
  connect(
    listener: StreamListener,
    signal: AbortSignal,
  ): Promise<SpeechStreamChannel>;
}
