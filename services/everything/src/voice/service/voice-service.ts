import {
  voiceLimits,
  voiceMediaTypes,
  type VoiceCapabilities,
  type VoiceTranscript,
} from "@everything/conversation-contracts/voice";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import {
  VoiceBusyError,
  VoiceCapacityError,
  VoiceUnavailableError,
} from "../error/voice-errors.js";
import type { AudioDecoder } from "../interface/audio-decoder.js";
import type { SpeechRecognizer } from "../interface/speech-recognizer.js";
import type {
  VoiceOperations,
  VoiceRecording,
  VoiceReservation,
} from "../interface/voice-operations.js";
import { audioFormat } from "../model/audio-format.js";
import { isSilent, waveFile } from "../model/pcm-audio.js";
import type { VoiceAdmission } from "./voice-admission.js";

/** Limits on recordings in progress and on how long a caller may wait for one. */
export interface VoiceServiceLimits {
  /** Recordings that may be uploading, waiting, or transcribing at once, across all owners. */
  readonly reservations: number;
  /** Longest a transcription request may take, including waiting for capacity. */
  readonly responseTimeoutMs: number;
}

/**
 * Transcribes one recording per owner at a time. A reservation taken before the upload is read
 * bounds buffered recordings per owner and in total; then the format is validated, teammate
 * ownership is checked, and a transcription slot is obtained before anything is decoded or sent to
 * the speech service. Silent recordings never reach the service. Nothing is stored or logged.
 */
export class VoiceService implements VoiceOperations {
  private readonly reserved = new Map<string, VoiceReservation>();
  private readonly shutdown = new AbortController();

  // ===========================================
  // Construction
  // ===========================================

  /** Compose ownership, decoding, recognition, and admission. */
  constructor(
    private readonly agents: Pick<AgentCatalog, "get">,
    private readonly decoder: AudioDecoder,
    private readonly recognizer: SpeechRecognizer,
    private readonly admission: VoiceAdmission,
    private readonly limits: VoiceServiceLimits,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Report availability and the limits recordings must meet. */
  capabilities(): VoiceCapabilities {
    return {
      available: this.recognizer.available,
      maxDurationMs: voiceLimits.maxDurationMs,
      maxBytes: voiceLimits.maxBytes,
      mediaTypes: [...voiceMediaTypes],
      responseTimeoutMs: this.limits.responseTimeoutMs,
    };
  }

  /** Reserve the owner's one recording place, refusing a second per owner and any beyond the total. */
  reserve(ownerId: string): VoiceReservation {
    if (!this.recognizer.available || this.shutdown.signal.aborted)
      throw new VoiceUnavailableError();
    if (this.reserved.has(ownerId)) throw new VoiceBusyError();
    if (this.reserved.size >= this.limits.reservations)
      throw new VoiceCapacityError();
    const reservation: VoiceReservation = {
      ownerId,
      release: () => {
        if (this.reserved.get(ownerId) === reservation)
          this.reserved.delete(ownerId);
      },
    };
    this.reserved.set(ownerId, reservation);
    return reservation;
  }

  /** Decode and transcribe a recording for a teammate the reservation's owner can access. */
  async transcribe(
    reservation: VoiceReservation,
    agentId: string,
    recording: VoiceRecording,
    signal: AbortSignal,
  ): Promise<VoiceTranscript> {
    if (this.reserved.get(reservation.ownerId) !== reservation)
      throw new VoiceUnavailableError();
    const format = audioFormat(recording.contentType, recording.bytes);
    await this.agents.get(reservation.ownerId, agentId);
    const abort = AbortSignal.any([signal, this.shutdown.signal]);
    try {
      const release = await this.admission.enter(abort);
      try {
        const pcm = await this.decoder.decode(
          { format, bytes: recording.bytes },
          abort,
        );
        if (isSilent(pcm)) return { text: "" };
        const text = await this.recognizer.transcribe(waveFile(pcm), abort);
        return { text: text.trim() };
      } finally {
        release();
      }
    } catch (error) {
      // The caller left or the service is stopping; nobody needs the detailed reason.
      if (abort.aborted) throw new VoiceUnavailableError();
      throw error;
    }
  }

  /** Abort running transcriptions and refuse new ones, so shutdown doesn't wait on the speech service. */
  close(): void {
    this.shutdown.abort();
    this.admission.close();
  }
}
