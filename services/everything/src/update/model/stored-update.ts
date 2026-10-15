import type { OwnedEntity } from "@everything/persistence/entity";
import type { StoredSummaryStatus } from "./update-record.js";

/** State every kind of update shares, independent of what produced it. */
export interface StoredUpdateBase extends OwnedEntity {
  readonly summary: string | null;
  readonly summaryStatus: StoredSummaryStatus;
  readonly summaryStartedAt: string | null;
  readonly readAt: string | null;
  /** The source's own text: what the model summarizes, previewed until a summary is ready. */
  readonly sourceText: string;
}

/** An update for a message a teammate delivered to its owner. */
export interface StoredMessageUpdate extends StoredUpdateBase {
  readonly kind: "message";
  readonly agentId: string;
  readonly messageId: string;
}

/** Every kind of stored update, discriminated by `kind`. */
export type StoredUpdate = StoredMessageUpdate;

/** Newest-first unread updates and the cursor for the next page. */
export interface UnreadUpdatePage {
  readonly updates: StoredUpdate[];
  readonly nextCursor: string | null;
}
