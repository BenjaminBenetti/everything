import type { OwnedEntity } from "@everything/persistence/entity";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import type { UpdateKind } from "@everything/update-contracts";

/** Summary timing and size limits. */
export const summaryTimeoutMs = 30_000;
export const abandonedSummaryMs = 120_000;
/**
 * Wait before summarizing so an owner watching the chat can send a receipt first. Covers the
 * chat's history poll (up to 5 s while idle), the 750 ms dwell, and the receipt request.
 */
export const summaryGraceMs = 10_000;
/** Room for minimal reasoning plus one short sentence; the result is clamped separately. */
export const summaryMaxTokens = 1024;

/** Internal maintenance scope: only unread updates old enough for a receipt to have arrived. */
export interface SummaryDueScope {
  readonly createdBefore: Date;
}

/** Pending summary work, carrying the owner scope needed to claim it. */
export interface UpdateSummaryTarget extends OwnedEntity {}

/** Source content and the owner's current model selection, acquired by an atomic claim. */
export interface UpdateSummaryInput extends UpdateSummaryTarget {
  readonly kind: UpdateKind;
  readonly text: string;
  /** The model of the teammate the update belongs to; null when no model is selected. */
  readonly inference: InferenceSelection | null;
}
