import type { FastifyInstance } from "fastify";
import { subject } from "@everything/security/fastify";
import {
  voiceLimits,
  voiceMediaTypes,
} from "@everything/conversation-contracts/voice";
import {
  agentParams,
  type AgentParams,
} from "../../agent/schema/agent-request.js";
import type {
  VoiceOperations,
  VoiceReservation,
} from "../interface/voice-operations.js";
import {
  voiceCapabilitiesResponse,
  voiceTranscriptResponse,
} from "../schema/voice-response.js";

/** Register voice input availability and teammate-scoped transcription. */
export async function voiceController(
  app: FastifyInstance,
  voice: VoiceOperations,
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
}
