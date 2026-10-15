import type { UpdateCount, UpdatePage } from "@everything/update-contracts";
import type { UpdateFeedStore } from "../interface/update-repository.js";
import type { UpdateOperations } from "../interface/update-operations.js";
import { representUpdate } from "../presenter/update-presenter.js";

/** Serve durable unread updates so polling and restarts cannot duplicate or lose them. */
export class UpdateService implements UpdateOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Accept only the feed and receipt capabilities, never summary generation. */
  constructor(private readonly updates: UpdateFeedStore) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read cached summaries or labeled previews without triggering inference or changing read state. */
  async list(ownerId: string, before?: string): Promise<UpdatePage> {
    const page = await this.updates.unread({ ownerId }, before);
    const now = Date.now();
    return {
      updates: page.updates.map((update) => representUpdate(update, now)),
      nextCursor: page.nextCursor,
    };
  }

  /** Count unread updates for the navigation badge. */
  async count(ownerId: string): Promise<UpdateCount> {
    return { unread: await this.updates.countUnread({ ownerId }) };
  }

  /** Record only the exact messages the client observed, preserving gaps and concurrent deliveries. */
  read(
    ownerId: string,
    agentId: string,
    messageIds: readonly string[],
  ): Promise<void> {
    return this.updates.readMessages({ ownerId, agentId }, messageIds);
  }
}
