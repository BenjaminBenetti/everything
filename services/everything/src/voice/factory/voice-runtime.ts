import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import {
  FfmpegAudioDecoder,
  defaultDecoderBudget,
} from "../adapter/ffmpeg-audio-decoder.js";
import { HttpSpeechRecognizer } from "../adapter/http-speech-recognizer.js";
import { UnavailableSpeechRecognizer } from "../adapter/unavailable-speech-recognizer.js";
import type { AudioDecoder } from "../interface/audio-decoder.js";
import type { VoiceSettings } from "../model/voice-settings.js";
import { VoiceAdmission } from "../service/voice-admission.js";
import { VoiceService } from "../service/voice-service.js";

/**
 * Assemble voice input. It is offered only when a speech recognition service is configured and the
 * decoder starts; otherwise every transcription is refused and capabilities report it unavailable.
 */
export async function createVoiceService(
  settings: VoiceSettings,
  agents: Pick<AgentCatalog, "get">,
  warn: (message: string) => void,
  decoder: AudioDecoder &
    Pick<FfmpegAudioDecoder, "verify"> = new FfmpegAudioDecoder(),
): Promise<VoiceService> {
  const decoderReady = !!settings.service && (await decoder.verify());
  if (settings.service && !decoderReady)
    warn(
      "Voice input is unavailable because the audio decoder couldn't start.",
    );
  return new VoiceService(
    agents,
    decoder,
    settings.service && decoderReady
      ? new HttpSpeechRecognizer(settings.service)
      : new UnavailableSpeechRecognizer(),
    new VoiceAdmission(settings.admission),
    {
      // Every running or queued transcription holds a reservation, so they share one bound.
      reservations:
        settings.admission.concurrency + settings.admission.queueLimit,
      responseTimeoutMs:
        settings.admission.queueTimeoutMs +
        defaultDecoderBudget.timeoutMs +
        (settings.service?.timeoutMs ?? 0),
    },
  );
}
