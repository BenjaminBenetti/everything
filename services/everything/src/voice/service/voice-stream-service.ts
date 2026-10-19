import type { VoiceStreamVersion } from "@everything/conversation-contracts/voice-stream";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import {
  VoiceCapacityError,
  VoiceUnavailableError,
} from "../error/voice-errors.js";
import type {
  SpeechStreams,
  StreamChannel,
} from "../interface/speech-streams.js";
import type {
  VoiceStreamLease,
  VoiceStreamOperations,
} from "../interface/voice-stream-operations.js";
import type { VoiceReservations } from "./voice-reservations.js";
import { VoiceStreamSession, streamTiming } from "./voice-stream-session.js";

/** Streaming limits from configuration. */
export interface VoiceStreamLimits {
  /** Streams that may run at once across all owners. */
  readonly concurrency: number;
  /** Longest to wait for a final transcript after end. */
  readonly finalTimeoutMs: number;
}

/**
 * Admits streams and runs their sessions. Admission checks that the teammate belongs to the owner
 * and takes the owner's single recording place, shared with uploads, and a stream slot, all before
 * the browser's connection is upgraded or any speech service work is requested.
 */
export class VoiceStreamService implements VoiceStreamOperations {
  private active = 0;
  private closed = false;
  private readonly sessions = new Set<VoiceStreamSession>();

  /** Compose ownership, shared reservations, and the speech service connection. */
  constructor(
    private readonly agents: Pick<AgentCatalog, "get">,
    private readonly reservations: VoiceReservations,
    private readonly streams: SpeechStreams | null,
    private readonly limits: VoiceStreamLimits,
  ) {}

  /** Whether a streaming speech service is configured. */
  get available(): boolean {
    return !!this.streams && !this.closed;
  }

  /** Check ownership and take the stream's places; refuses with the same errors as uploads. */
  async admit(ownerId: string, agentId: string): Promise<VoiceStreamLease> {
    if (!this.available) throw new VoiceUnavailableError();
    await this.agents.get(ownerId, agentId);
    const reservation = this.reservations.reserve(ownerId);
    if (this.active >= this.limits.concurrency || this.closed) {
      reservation.release();
      throw this.closed
        ? new VoiceUnavailableError()
        : new VoiceCapacityError();
    }
    this.active++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        reservation.release();
      },
    };
  }

  /** Run an admitted stream over the browser's connection; its places return when it finishes. */
  open(
    lease: VoiceStreamLease,
    browser: StreamChannel,
    version: VoiceStreamVersion,
  ): VoiceStreamSession {
    // Nothing reaches the speech service after shutdown; the caller releases the places.
    if (!this.streams || this.closed) throw new VoiceUnavailableError();
    const session: VoiceStreamSession = new VoiceStreamSession(
      browser,
      this.streams,
      { ...streamTiming, finalTimeoutMs: this.limits.finalTimeoutMs },
      () => {
        this.sessions.delete(session);
        lease.release();
      },
      version,
    );
    this.sessions.add(session);
    return session;
  }

  /** Stop every stream and refuse new ones, for shutdown. */
  close(): void {
    this.closed = true;
    for (const session of [...this.sessions]) session.shutdown();
  }
}
