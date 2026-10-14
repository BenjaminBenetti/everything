import type { OwnedEntity } from "@everything/persistence/entity";
import type { InferenceSelection } from "@everything/provider-contracts/inference";

/** Durable state for a single attempt, separate from the visible conversation and its receipts. */
export type StoredSummaryStatus = "pending" | "generating" | "ready" | "failed";
export const summaryTimeoutMs = 30_000;
export const abandonedSummaryMs = 120_000;
export const summaryMaxLength = 280;

/** A maintenance projection carrying the scope required to claim one visible message. */
export interface MessageSummaryTarget extends OwnedEntity {
  readonly agentId: string;
}

/** Source content and the owner's current model selection, acquired by an atomic claim. */
export interface MessageSummaryInput extends MessageSummaryTarget {
  readonly text: string;
  readonly inference: InferenceSelection | null;
}
