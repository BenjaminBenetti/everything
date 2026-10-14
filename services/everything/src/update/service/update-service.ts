import type { UpdatePage } from "@everything/conversation-contracts";
import type { MessageUpdates } from "../interface/message-updates.js";
import type { UpdateOperations } from "../interface/update-operations.js";
import { messagePreview } from "./message-summary.js";
import { abandonedSummaryMs } from "../model/message-summary.js";

/** Derive updates from durable unread messages so polling and restarts cannot duplicate delivery. */
export class UpdateService implements UpdateOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Accept only the visible message store's receipt and unread capabilities. */
  constructor(private readonly messages: MessageUpdates) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read cached summaries or labeled previews without triggering inference or changing read state. */
  async list(ownerId: string, before?: string): Promise<UpdatePage> {
    const page = await this.messages.unread({ ownerId }, before);
    return {
      updates: page.messages.map((message) => ({
        messageId: message.id,
        agentId: message.agentId,
        summary: message.updateSummary ?? messagePreview(message.text),
        summaryStatus:
          message.summaryStatus === "ready"
            ? "ready"
            : message.summaryStatus === "failed" ||
                (message.summaryStatus === "generating" &&
                  message.summaryStartedAt !== null &&
                  Date.now() - Date.parse(message.summaryStartedAt) >
                    abandonedSummaryMs)
              ? "unavailable"
              : "pending",
        createdAt: message.createdAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Record only the exact messages the client observed, preserving gaps and concurrent deliveries. */
  read(
    ownerId: string,
    agentId: string,
    messageIds: readonly string[],
  ): Promise<void> {
    return this.messages.markRead({ ownerId, agentId }, messageIds);
  }
}
