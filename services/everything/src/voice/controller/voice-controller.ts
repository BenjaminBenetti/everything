import type { FastifyInstance, FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { subject } from "@everything/security/fastify";
import {
  voiceLimits,
  voiceMediaTypes,
} from "@everything/conversation-contracts/voice";
import {
  voiceStreamLimits,
  voiceStreamProtocolVersion,
  voiceStreamProtocols,
} from "@everything/conversation-contracts/voice-stream";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import type {
  VoiceOperations,
  VoiceReservation,
} from "../interface/voice-operations.js";
import { VoiceUnavailableError } from "../error/voice-errors.js";
import type {
  VoiceStreamEvents,
  VoiceStreamLease,
  VoiceStreamOperations,
} from "../interface/voice-stream-operations.js";
import {
  voiceCapabilitiesResponse,
  voiceTranscriptResponse,
} from "../schema/voice-response.js";

/**
 * Largest WebSocket message read from a browser. Bigger than any valid stream message, so slightly
 * oversized audio gets a protocol error; anything larger closes the connection.
 */
export const maxBrowserMessageBytes = 8 * 1024;

/**
 * WebSocket support for the whole application. It must be registered before every route, at the
 * root, so upgrade requests are marked before authentication runs: then any upgrade refused by
 * authentication, the origin check, validation, or admission, or aimed at a route that isn't a
 * stream, has its connection destroyed instead of lingering half-open. Connections are upgraded
 * only by the stream route's handler, after every check has passed. Of the voice stream
 * subprotocols a browser offers, the newest is selected; a browser that offers none speaks version 1.
 */
export async function registerVoiceWebSocket(
  app: FastifyInstance,
): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: maxBrowserMessageBytes,
      handleProtocols: (offered) =>
        [voiceStreamProtocols[2], voiceStreamProtocols[1]].find((protocol) =>
          offered.has(protocol),
        ) ?? false,
    },
    // Errors on an established socket are not logged; they can only end the stream.
    errorHandler: (_error, socket) => socket.terminate(),
  });
  // The plugin would complete the handshake for any route before closing it again, so an upgrade
  // aimed at anything but a voice stream is refused here, before authentication or any handler,
  // and its connection is destroyed.
  app.addHook("onRequest", async (request, reply) => {
    if (request.ws && !request.routeOptions.config?.voiceStream)
      return reply.code(404).send({ code: "NOT_FOUND", message: "Not found." });
  });
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Marks the one route that may upgrade to a WebSocket. */
    voiceStream?: boolean;
  }
}

/** One upgrade request's admission: its places, once given, and whether its connection is gone. */
interface Admission {
  lease: VoiceStreamLease | null;
  running: boolean;
  closed: boolean;
}

/** Register voice input availability, uploaded transcription, and streaming transcription. */
export async function voiceController(
  app: FastifyInstance,
  voice: VoiceOperations,
  streams: VoiceStreamOperations,
  /** Rejects cookie-authenticated requests from any origin but the application's. */
  requireOrigin: (request: FastifyRequest) => void,
): Promise<void> {
  app.get(
    "/voice/capabilities",
    {
      schema: {
        summary: "Read whether voice input is available",
        description:
          "Reports whether this installation has a self-hosted speech recognition service, and the recording limits it applies.",
        response: { 200: voiceCapabilitiesResponse },
      },
    },
    async () => voice.capabilities(),
  );

  // Each request's reservation, taken before its body is read.
  const reservations = new WeakMap<object, VoiceReservation>();

  // Recordings are the only raw bodies the API reads, so their parsers and size limit stay in this
  // scope; every other route keeps rejecting audio, and this route rejects JSON and forms.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      [...voiceMediaTypes],
      { parseAs: "buffer", bodyLimit: voiceLimits.maxBytes },
      (_request, body, done) => done(null, body),
    );
    scope.post<{ Params: AgentParams; Body: Buffer | undefined }>(
      "/agents/:agentId/voice/transcriptions",
      {
        bodyLimit: voiceLimits.maxBytes,
        /**
         * Runs after authentication and before the body is read: a caller over the per-owner or
         * total limit is refused without its upload being buffered. The reservation ends with the
         * response, whether it succeeds, fails, or the caller disconnects.
         */
        onRequest: async (request, reply) => {
          const reservation = voice.reserve(subject(request));
          reservations.set(request, reservation);
          reply.raw.once("close", () => reservation.release());
        },
        schema: {
          summary: "Transcribe a voice recording for the teammate's message",
          description: `Send one finished browser recording as the raw request body, with its recorder's content type (${voiceMediaTypes.join(", ")}; codec parameters are allowed), up to ${voiceLimits.maxBytes} bytes and ${voiceLimits.maxDurationMs / 1000} seconds of decoded audio. Returns the final transcript, which is empty when no speech was recognized; nothing is sent to the teammate. Each owner can have one recording uploading or in progress (429), and 503 means voice input is unavailable or busy; both are refused before the upload is read. Recordings and transcripts are not stored.`,
          consumes: [...voiceMediaTypes],
          params: agentParams,
          response: { 200: voiceTranscriptResponse },
        },
      },
      async (request, reply) => {
        const abort = new AbortController();
        // The request's own close event fires once its body is read; the response's means the caller left.
        reply.raw.once("close", () => {
          if (!reply.raw.writableFinished) abort.abort();
        });
        const reservation = reservations.get(request);
        if (!reservation)
          throw new Error("Transcription route is missing its reservation");
        return voice.transcribe(
          reservation,
          request.params.agentId,
          {
            contentType: request.headers["content-type"],
            bytes: request.body ?? Buffer.alloc(0),
          },
          abort.signal,
        );
      },
    );
  });

  // The streaming route upgrades to a WebSocket only after authentication, the origin check,
  // teammate ownership, and admission have all passed; until then every refusal is plain HTTP.
  await app.register(async (scope) => {
    const admitted = new WeakMap<object, Admission>();
    scope.get<{ Params: AgentParams }>(
      "/agents/:agentId/voice/stream",
      {
        websocket: true,
        config: { voiceStream: true },
        onRequest: async (request, reply) => {
          requireOrigin(request);
          // Only WebSocket upgrades take places; an ordinary request is answered at once.
          if (!request.ws)
            return reply
              .code(404)
              .send({ code: "NOT_FOUND", message: "Not found." });
        },
        preHandler: async (request) => {
          const connection = request.raw.socket;
          const entry: Admission = {
            lease: null,
            running: false,
            closed: connection.destroyed,
          };
          admitted.set(request, entry);
          // Watched from before admission: a caller that leaves while ownership is being checked
          // must not strand the places it is then given. Once a stream runs, it releases them.
          connection.once("close", () => {
            entry.closed = true;
            if (!entry.running) entry.lease?.release();
          });
          const lease = await streams.admit(
            subject(request),
            request.params.agentId,
          );
          if (entry.closed) {
            lease.release();
            throw new VoiceUnavailableError();
          }
          entry.lease = lease;
        },
        schema: {
          summary: "Stream voice input while the microphone is held",
          description: `WebSocket voice streaming: a JSON start, binary audio messages (a uint32 little-endian sequence then up to ${voiceStreamLimits.maxFrameSamples} samples of 16 kHz mono PCM16LE), and a JSON end, answered by ready, cumulative acks, and one final transcript; cancel is acknowledged by cancelled. Offering the subprotocol ${voiceStreamProtocols[2]} selects version 2, which adds partial transcripts while audio streams; without it the stream is version 1. Not part of the generated API definition.`,
          params: agentParams,
        },
      },
      (socket, request) => {
        const entry = admitted.get(request);
        const lease = entry?.lease;
        if (!entry || !lease || entry.closed) {
          lease?.release();
          return socket.terminate();
        }
        let session: VoiceStreamEvents;
        try {
          session = streams.open(
            lease,
            {
              send: (message) => {
                if (socket.readyState === socket.OPEN) socket.send(message);
              },
              close: () => socket.close(1000),
              get bufferedAmount() {
                return socket.bufferedAmount;
              },
            },
            voiceStreamProtocolVersion(socket.protocol),
          );
        } catch {
          lease.release();
          return socket.terminate();
        }
        entry.running = true;
        socket.on("message", (data: Buffer, binary: boolean) =>
          session.fromBrowser(data, binary),
        );
        socket.on("close", () => session.browserClosed());
        if (socket.readyState !== socket.OPEN) session.browserClosed();
      },
    );
  });
}
