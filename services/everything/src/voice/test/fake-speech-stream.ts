import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { decodeVoiceFrame } from "@everything/conversation-contracts/voice-stream";

/** What the stand-in speech service observed. */
export interface FakeStreamRecord {
  /** Authorization header of each connection. */
  readonly authorizations: (string | undefined)[];
  /** Every text message received, parsed. */
  readonly controls: Record<string, unknown>[];
  /** Sequence and sample count of every audio message received. */
  readonly frames: { sequence: number; samples: number }[];
  /** Paths requested, including their query strings. */
  readonly paths: string[];
  /** Connections currently open. */
  open: number;
}

/** How the stand-in behaves. */
export interface FakeStreamBehavior {
  /** Acknowledge each audio message on arrival; otherwise never acknowledge. */
  readonly acknowledge?: boolean;
  /** Final text for an end; defaults to a summary of what was received. */
  readonly final?: (samples: number) => string;
  /** Delay before confirming a cancel. */
  readonly cancelDelayMs?: number;
  /** Replaces ready after start, for example to send something malformed. */
  readonly afterStart?: (socket: FakeSocket) => void;
}

/** The stand-in's side of one connection. */
export type FakeSocket = WebSocket;

/**
 * A stand-in for the native streaming speech service implementing the v1 contract on a local port:
 * ready after start, cumulative acks, one final after end, cancelled after cancel.
 */
export async function fakeSpeechStream(
  context: TestContext,
  behavior: FakeStreamBehavior = {},
): Promise<{ url: string; record: FakeStreamRecord }> {
  const record: FakeStreamRecord = {
    authorizations: [],
    controls: [],
    frames: [],
    paths: [],
    open: 0,
  };
  const app = Fastify();
  await app.register(websocket);
  app.get("/v1/stream", { websocket: true }, (socket, request) => {
    record.authorizations.push(request.headers.authorization);
    record.paths.push(request.url);
    record.open++;
    let samples = 0;
    socket.on("close", () => record.open--);
    socket.on("message", (data: Buffer, binary: boolean) => {
      if (binary) {
        const frame = decodeVoiceFrame(data);
        if (!frame) return;
        record.frames.push(frame);
        samples += frame.samples;
        if (behavior.acknowledge !== false)
          socket.send(
            JSON.stringify({ type: "ack", sequence: frame.sequence }),
          );
        return;
      }
      const message = JSON.parse(data.toString("utf8")) as Record<
        string,
        unknown
      >;
      record.controls.push(message);
      if (message.type === "start" && behavior.afterStart)
        behavior.afterStart(socket);
      else if (message.type === "start")
        socket.send(
          JSON.stringify({
            type: "ready",
            version: 1,
            maxSamples: 960_000,
            maxFrameSamples: 3_200,
            windowSamples: 16_000,
          }),
        );
      else if (message.type === "end") {
        socket.send(
          JSON.stringify({
            type: "final",
            text: behavior.final
              ? behavior.final(samples)
              : `Heard ${samples} samples.`,
          }),
        );
        socket.close(1000);
      } else if (message.type === "cancel")
        setTimeout(() => {
          if (socket.readyState !== socket.OPEN) return;
          socket.send(JSON.stringify({ type: "cancelled" }));
          socket.close(1000);
        }, behavior.cancelDelayMs ?? 0);
    });
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  context.after(() => app.close());
  const { port } = app.server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/v1/stream`, record };
}
