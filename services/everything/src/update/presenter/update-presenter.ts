import type { Update, UpdateSummaryStatus } from "@everything/update-contracts";
import type { StoredUpdate } from "../model/stored-update.js";
import { abandonedSummaryMs } from "../model/update-summary.js";
import { clampSummary } from "../service/summary-text.js";

/** Show the source when summaries are disabled, retaining cached results for re-enabling. */
export function representUpdate(
  update: StoredUpdate,
  now: number,
  summarizeUpdates: boolean,
): Update {
  const shared = {
    id: update.id,
    summary:
      (summarizeUpdates ? update.summary : null) ??
      clampSummary(update.sourceText),
    summaryStatus: summarizeUpdates
      ? summaryStatus(update, now)
      : ("disabled" as const),
    createdAt: update.createdAt,
  };
  switch (update.kind) {
    case "message":
      return {
        ...shared,
        kind: "message",
        agentId: update.agentId,
        messageId: update.messageId,
      };
  }
}

/** Seen messages without cached summaries remain previews because they no longer need inference. */
function summaryStatus(
  { summaryStatus, summaryStartedAt, readAt }: StoredUpdate,
  now: number,
): UpdateSummaryStatus {
  if (summaryStatus === "ready") return "ready";
  if (readAt !== null || summaryStatus === "failed") return "unavailable";
  if (
    summaryStatus === "generating" &&
    summaryStartedAt !== null &&
    now - Date.parse(summaryStartedAt) > abandonedSummaryMs
  )
    return "unavailable";
  return "pending";
}
