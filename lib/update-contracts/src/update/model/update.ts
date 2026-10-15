/** Update limits shared by the feed API, persistence, and summarizer. */
export const updatePageSize = 50;
export const updateSummaryMaxLength = 200;

/** Whether the summary is a cached model result or a clearly labeled source preview. */
export type UpdateSummaryStatus = "pending" | "ready" | "unavailable";

/** Fields every kind of update shares, independent of what produced it. */
export interface UpdateBase {
  readonly id: string;
  readonly kind: string;
  /** A short explanation of why the update needs the owner's attention. */
  readonly summary: string;
  readonly summaryStatus: UpdateSummaryStatus;
  readonly createdAt: string;
}

/** A message a teammate sent to its owner that the owner hasn't seen yet. */
export interface MessageUpdate extends UpdateBase {
  readonly kind: "message";
  readonly agentId: string;
  readonly messageId: string;
}

/** Every kind of update; add a variant here for each new kind. */
export type Update = MessageUpdate;
export type UpdateKind = Update["kind"];

/** Newest-first unread updates; the cursor remains valid after an update is read. */
export interface UpdatePage {
  readonly updates: Update[];
  readonly nextCursor: string | null;
}

/** The number of unread updates, shown as a badge in navigation. */
export interface UpdateCount {
  readonly unread: number;
}
