import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import {
  FfmpegAudioDecoder,
  defaultDecoderBudget,
} from "../adapter/ffmpeg-audio-decoder.js";
import { HttpSpeechRecognizer } from "../adapter/http-speech-recognizer.js";
import { UnavailableSpeechRecognizer } from "../adapter/unavailable-speech-recognizer.js";
import { WebSocketSpeechStreams } from "../adapter/websocket-speech-streams.js";
import type { AudioDecoder } from "../interface/audio-decoder.js";
import type { SpeechStreams } from "../interface/speech-streams.js";
import type { VoiceSettings } from "../model/voice-settings.js";
import { VoiceAdmission } from "../service/voice-admission.js";
import { VoiceReservations } from "../service/voice-reservations.js";
import { VoiceService } from "../service/voice-service.js";
import { VoiceStreamService } from "../service/voice-stream-service.js";
import { maxServiceMessageBytes } from "../service/voice-stream-session.js";

/** Both voice input lanes, sharing one reservation per owner. */
export interface VoiceRuntime {
  /** Uploaded recordings, transcribed after they finish. */
  readonly uploads: VoiceService;
  /** Audio streamed while the microphone is held. */
  readonly streams: VoiceStreamService;
  /** Stop both lanes' work and refuse new recordings, for shutdown. */
  close(): void;
}

/**
 * Assemble voice input. Each lane is offered only when its speech service is configured; uploads
 * also need the decoder to start. Unconfigured lanes refuse every recording and report themselves
 * unavailable.
 */
export async function createVoiceRuntime(
  settings: VoiceSettings,
  agents: Pick<AgentCatalog, "get">,
  warn: (message: string) => void,
  decoder: AudioDecoder &
    Pick<FfmpegAudioDecoder, "verify"> = new FfmpegAudioDecoder(),
  streams: SpeechStreams | null = settings.stream
    ? new WebSocketSpeechStreams(settings.stream, maxServiceMessageBytes)
    : null,
): Promise<VoiceRuntime> {
  const decoderReady = !!settings.service && (await decoder.verify());
  if (settings.service && !decoderReady)
    warn(
      "Voice input is unavailable because the audio decoder couldn't start.",
    );
  const streamConcurrency = settings.stream ? settings.stream.concurrency : 0;
  // Every running or queued upload and every stream holds a reservation, so they share one bound.
  const reservations = new VoiceReservations(
    settings.admission.concurrency +
      settings.admission.queueLimit +
      streamConcurrency,
  );
  const finalTimeoutMs = settings.stream?.finalTimeoutMs ?? 0;
  const uploads = new VoiceService(
    agents,
    decoder,
    settings.service && decoderReady
      ? new HttpSpeechRecognizer(settings.service)
      : new UnavailableSpeechRecognizer(),
    new VoiceAdmission(settings.admission),
    reservations,
    {
      responseTimeoutMs:
        settings.admission.queueTimeoutMs +
        defaultDecoderBudget.timeoutMs +
        (settings.service?.timeoutMs ?? 0),
      streaming: !!streams,
      streamFinalTimeoutMs: finalTimeoutMs,
    },
  );
  const streamService = new VoiceStreamService(agents, reservations, streams, {
    concurrency: Math.max(streamConcurrency, 1),
    finalTimeoutMs,
  });
  return {
    uploads,
    streams: streamService,
    close: () => {
      uploads.close();
      streamService.close();
    },
  };
}
