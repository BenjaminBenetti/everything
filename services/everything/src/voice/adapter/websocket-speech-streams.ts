import { WebSocket } from "ws";
import type {
  SpeechStreams,
  StreamChannel,
  StreamListener,
} from "../interface/speech-streams.js";
import type { SpeechStreamSettings } from "../model/voice-settings.js";

/** How long the WebSocket handshake with the speech service may take. */
const handshakeTimeoutMs = 5_000;

/**
 * Connects to the operator's streaming speech service. The URL and token come only from deployment
 * configuration; the token travels in the Authorization header, never the URL. Redirects are
 * refused and compression is never negotiated. `maxMessageBytes` is enforced by the WebSocket
 * receiver from frame headers, across fragments, so an oversized message is refused before its
 * payload is buffered, and the connection closes.
 */
export class WebSocketSpeechStreams implements SpeechStreams {
  /** Bind the configured service and the largest message it may send. */
  constructor(
    private readonly settings: Pick<SpeechStreamSettings, "url" | "token">,
    private readonly maxMessageBytes: number,
  ) {}

  /** Open one stream connection. */
  connect(
    listener: StreamListener,
    signal: AbortSignal,
  ): Promise<StreamChannel> {
    if (signal.aborted) return Promise.reject(new Error("Aborted"));
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.settings.url, {
        headers: this.settings.token
          ? { authorization: `Bearer ${this.settings.token}` }
          : {},
        maxPayload: this.maxMessageBytes,
        perMessageDeflate: false,
        followRedirects: false,
        handshakeTimeout: handshakeTimeoutMs,
      });
      let open = false;
      const channel: StreamChannel = {
        send: (message) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(message);
        },
        close: () => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1000);
          else if (socket.readyState === WebSocket.CONNECTING)
            socket.terminate();
        },
        get bufferedAmount() {
          return socket.bufferedAmount;
        },
      };
      const abort = (): void => socket.terminate();
      signal.addEventListener("abort", abort, { once: true });
      socket.on("open", () => {
        open = true;
        signal.removeEventListener("abort", abort);
        resolve(channel);
      });
      socket.on("message", (data: Buffer, binary: boolean) =>
        listener.message(binary ? new Uint8Array(data) : data.toString("utf8")),
      );
      // Errors include oversized or malformed frames and refused handshakes. The connection is
      // dropped at once rather than waiting for a misbehaving service to answer a close, so the
      // stream's places return promptly. Details may describe the service and are never logged.
      socket.on("error", () => socket.terminate());
      socket.on("close", () => {
        signal.removeEventListener("abort", abort);
        if (open) listener.closed();
        else reject(new Error("The speech service couldn't be reached"));
      });
    });
  }
}
