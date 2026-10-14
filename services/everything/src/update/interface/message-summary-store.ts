import type { MessageScope } from "../../conversation/interface/message-repository.js";
import type {
  MessageSummaryInput,
  MessageSummaryTarget,
} from "../model/message-summary.js";

/** Internal maintenance scope; only unread public replies old enough for a receipt are eligible. */
export interface SummaryDueScope {
  readonly createdBefore: Date;
}

/** Persist claims before external inference so refreshes, competing workers, and restarts cannot repeat it. */
export interface MessageSummaryStore {
  pendingSummaries(scope: SummaryDueScope): Promise<MessageSummaryTarget[]>;
  claimSummary(
    scope: MessageScope,
    messageId: string,
  ): Promise<MessageSummaryInput | undefined>;
  finishSummary(
    scope: MessageScope,
    messageId: string,
    summary: string | null,
  ): Promise<void>;
}
