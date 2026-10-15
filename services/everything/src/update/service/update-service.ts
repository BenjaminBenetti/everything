import type { UpdateCount, UpdatePage } from "@everything/update-contracts";
import type { UpdateFeedStore } from "../interface/update-repository.js";
import type { UpdateOperations } from "../interface/update-operations.js";
import { representUpdate } from "../presenter/update-presenter.js";
import type { GeneralSettingsReader } from "../../settings/interface/general-settings.js";
import type { StoredUpdatePage } from "../model/stored-update.js";

/** Serve durable unread updates and seen history without changing receipts or triggering inference. */
export class UpdateService implements UpdateOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Accept feed, receipt, and preference reading capabilities independently of inference. */
  constructor(
    private readonly updates: UpdateFeedStore,
    private readonly settings: GeneralSettingsReader,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read cached summaries or labeled previews without triggering inference or changing read state. */
  list(ownerId: string, before?: string): Promise<UpdatePage> {
    return this.present(ownerId, this.updates.unread({ ownerId }, before));
  }

  /** Keep seen updates accessible with the owner's current summary preference. */
  seen(ownerId: string, before?: string): Promise<UpdatePage> {
    return this.present(ownerId, this.updates.seen({ ownerId }, before));
  }

  /** Count unread updates for navigation and each teammate's badge. */
  count(ownerId: string): Promise<UpdateCount> {
    return this.updates.countUnread({ ownerId });
  }

  /** Record only the exact messages the client observed, preserving gaps and concurrent deliveries. */
  read(
    ownerId: string,
    agentId: string,
    messageIds: readonly string[],
  ): Promise<void> {
    return this.updates.readMessages({ ownerId, agentId }, messageIds);
  }

  // ===========================================
  // Presentation
  // ===========================================

  /** Apply the same summary and source-preview policy to both read states. */
  private async present(
    ownerId: string,
    pageResult: Promise<StoredUpdatePage>,
  ): Promise<UpdatePage> {
    const [page, settings] = await Promise.all([
      pageResult,
      this.settings.read(ownerId),
    ]);
    const now = Date.now();
    return {
      updates: page.updates.map((update) =>
        representUpdate(update, now, settings.summarizeUpdates),
      ),
      nextCursor: page.nextCursor,
    };
  }
}
