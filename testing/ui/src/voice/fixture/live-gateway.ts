import type { BrowserContext, WebSocketRoute } from "@playwright/test";

/** What the stand-in gateway observed, and how the test drives it. */
export interface LiveGateway {
  /** The version of each start received. */
  readonly starts: number[];
  /** Audio messages received. */
  frames: number;
  /** End messages received. */
  ends: number;
  /** Cancel messages received. */
  cancels: number;
  /** Send a partial transcript with the next revision. */
  partial(text: string): void;
  /** Send the final transcript; only valid after end. */
  final(text: string): void;
}

/**
 * Replace the voice stream with a stand-in gateway that speaks version 2: the page sees the
 * subprotocol a version 2 gateway selects, every audio message is acknowledged, and the test sends
 * partials and the final when it chooses. The microphone is a real, silent MediaStream, so the
 * browser's own audio worklet captures and frames the audio; no device is opened.
 */
export async function liveGateway(
  context: BrowserContext,
): Promise<LiveGateway> {
  let socket: WebSocketRoute | null = null;
  let revision = 0;
  const gateway: LiveGateway = {
    starts: [],
    frames: 0,
    ends: 0,
    cancels: 0,
    partial(text) {
      socket?.send(
        JSON.stringify({ type: "partial", revision: ++revision, text }),
      );
    },
    final(text) {
      socket?.send(JSON.stringify({ type: "final", text }));
      void socket?.close({ code: 1000 });
    },
  };
  await context.addInitScript(() => {
    // A gateway that speaks version 2 selects its subprotocol; a routed socket reports none. The
    // route installs its own WebSocket class by assignment, so whichever class is installed, before
    // or after this script, is wrapped.
    const negotiated = (Base: typeof WebSocket): typeof WebSocket =>
      class extends Base {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).endsWith("/voice/stream"))
            Object.defineProperty(this, "protocol", {
              get: () => "voice-stream.2",
              set: () => undefined,
            });
        }
      };
    let current = negotiated(window.WebSocket);
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      get: () => current,
      set: (next: typeof WebSocket) => (current = negotiated(next)),
    });
    const silence = () => {
      const audio = new AudioContext();
      const destination = audio.createMediaStreamDestination();
      const source = audio.createConstantSource();
      source.offset.value = 0;
      source.connect(destination);
      source.start();
      return Promise.resolve(destination.stream);
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      get: () => ({ getUserMedia: silence }),
    });
  });
  await context.routeWebSocket("**/voice/stream", (route) => {
    socket = route;
    revision = 0;
    route.onMessage((message) => {
      if (typeof message !== "string") {
        gateway.frames++;
        const sequence = message.readUInt32LE(0);
        route.send(JSON.stringify({ type: "ack", sequence }));
        return;
      }
      const control = JSON.parse(message) as { type: string; version?: number };
      if (control.type === "start") {
        gateway.starts.push(control.version ?? 0);
        route.send(
          JSON.stringify({
            type: "ready",
            version: control.version,
            maxSamples: 960_000,
            maxFrameSamples: 3_200,
            windowSamples: 16_000,
          }),
        );
      } else if (control.type === "end") gateway.ends++;
      else if (control.type === "cancel") {
        gateway.cancels++;
        route.send(JSON.stringify({ type: "cancelled" }));
        void route.close({ code: 1000 });
      }
    });
  });
  return gateway;
}
