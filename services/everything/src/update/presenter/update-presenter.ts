import type { Update, UpdateSummaryStatus } from "@everything/update-contracts";
import type { StoredUpdate } from "../model/stored-update.js";
import { abandonedSummaryMs } from "../model/update-summary.js";
import { clampSummary } from "../service/summary-text.js";

/** Map a stored update to its public variant, previewing the source until a summary is ready. */
export function representUpdate(update: StoredUpdate, now: number): Update {
  const shared = {
    id: update.id,
    summary: update.summary ?? clampSummary(update.sourceText),
    summaryStatus: summaryStatus(update, now),
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

/** Failed and abandoned attempts are unavailable, since neither is ever retried. */
function summaryStatus(
  { summaryStatus, summaryStartedAt }: StoredUpdate,
  now: number,
): UpdateSummaryStatus {
  if (summaryStatus === "ready") return "ready";
  if (summaryStatus === "failed") return "unavailable";
  if (
    summaryStatus === "generating" &&
    summaryStartedAt !== null &&
    now - Date.parse(summaryStartedAt) > abandonedSummaryMs
  )
    return "unavailable";
  return "pending";
}
