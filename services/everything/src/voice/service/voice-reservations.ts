import { VoiceBusyError, VoiceCapacityError } from "../error/voice-errors.js";
import type { VoiceReservation } from "../interface/voice-operations.js";

/**
 * One recording place per owner, shared by every voice lane, and a bounded number in total. A place
 * is taken before a recording's audio is read, and its owner's next recording is refused until it is
 * released.
 */
export class VoiceReservations {
  private readonly held = new Map<string, VoiceReservation>();

  /** Allow at most `total` recordings at once across all owners. */
  constructor(private readonly total: number) {}

  /** Take the owner's place, refusing a second per owner and any beyond the total. */
  reserve(ownerId: string): VoiceReservation {
    if (this.held.has(ownerId)) throw new VoiceBusyError();
    if (this.held.size >= this.total) throw new VoiceCapacityError();
    const reservation: VoiceReservation = {
      ownerId,
      release: () => {
        if (this.held.get(ownerId) === reservation) this.held.delete(ownerId);
      },
    };
    this.held.set(ownerId, reservation);
    return reservation;
  }

  /** Whether this exact reservation is still held. */
  holds(reservation: VoiceReservation): boolean {
    return this.held.get(reservation.ownerId) === reservation;
  }
}
