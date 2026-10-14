import type { OwnerScope } from "@everything/persistence/repository";
import type { MessageRecord } from "../../conversation/model/message-record.js";
import type { MessageScope } from "../../conversation/interface/message-repository.js";

/** The visible message data needed to build an owner's feed, never private runtime records. */
export interface UnreadMessagePage {
  readonly messages: Array<
    Pick<
      MessageRecord,
      | "id"
      | "text"
      | "createdAt"
      | "agentId"
      | "updateSummary"
      | "summaryStatus"
      | "summaryStartedAt"
    >
  >;
  readonly nextCursor: string | null;
}

/** Narrow persistence capabilities for unread previews and explicit, idempotent receipts. */
export interface MessageUpdates {
  unread(scope: OwnerScope, before?: string): Promise<UnreadMessagePage>;
  markRead(scope: MessageScope, messageIds: readonly string[]): Promise<void>;
}
