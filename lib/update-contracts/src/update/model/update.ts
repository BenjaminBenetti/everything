/** Update limits shared by the feed API, persistence, and summarizer. */
export const updatePageSize = 50;
export const updateSummaryMaxLength = 200;

/** Whether the summary is a cached model result or a clearly labeled source preview. */
export type UpdateSummaryStatus =
  "pending" | "ready" | "unavailable" | "disabled";

/** Fields every kind of update shares, independent of what produced it. */
export interface UpdateBase {
  readonly id: string;
  readonly kind: string;
  /** A short explanation of why the update needs the owner's attention. */
  readonly summary: string;
  readonly summaryStatus: UpdateSummaryStatus;
  readonly createdAt: string;
}

/** A message a teammate sent to its owner, shown in unread updates or seen history. */
export interface MessageUpdate extends UpdateBase {
  readonly kind: "message";
  readonly agentId: string;
  readonly messageId: string;
}

/** Every kind of update; add a variant here for each new kind. */
export type Update = MessageUpdate;
export type UpdateKind = Update["kind"];

/** A newest-first page of updates; the cursor remains valid after an update is read. */
export interface UpdatePage {
  readonly updates: Update[];
  readonly nextCursor: string | null;
}

/** Unread totals for navigation and teammate badges, independent of feed pagination. */
export interface UpdateCount {
  readonly unread: number;
  /** Positive counts by teammate ID; teammates absent from this map have no unread updates. */
  readonly byAgent: Readonly<Record<string, number>>;
}
