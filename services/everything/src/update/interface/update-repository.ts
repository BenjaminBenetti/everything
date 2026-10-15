import type {
  OwnerScope,
  Repository,
} from "@everything/persistence/repository";
import type { MessageScope } from "../../conversation/interface/message-repository.js";
import type { StoredUpdate, UnreadUpdatePage } from "../model/stored-update.js";
import type {
  SummaryDueScope,
  UpdateSummaryInput,
  UpdateSummaryTarget,
} from "../model/update-summary.js";

/** Persistence boundary for directly owned updates of every kind. */
export interface UpdateRepository extends Repository<StoredUpdate, OwnerScope> {
  /** Read a newest-first page of unread updates; a cursor stays valid after its update is read. */
  unread(scope: OwnerScope, before?: string): Promise<UnreadUpdatePage>;
  /** Count the owner's unread updates. */
  countUnread(scope: OwnerScope): Promise<number>;
  /** Record the first receipt for a teammate's message updates, verifying and locking the teammate. */
  readMessages(
    scope: MessageScope,
    messageIds: readonly string[],
  ): Promise<void>;
  /** Discover a bounded batch of unread updates still waiting for a summary. */
  pendingSummaries(scope: SummaryDueScope): Promise<UpdateSummaryTarget[]>;
  /** Commit the only summary attempt before inference; undefined when the update is no longer eligible. */
  claimSummary(
    scope: OwnerScope,
    id: string,
  ): Promise<UpdateSummaryInput | undefined>;
  /** Save the claimed attempt's result once; null records a failure. */
  finishSummary(
    scope: OwnerScope,
    id: string,
    summary: string | null,
  ): Promise<void>;
}

/** The feed reads and acknowledges updates but never generates summaries. */
export type UpdateFeedStore = Pick<
  UpdateRepository,
  "unread" | "countUnread" | "readMessages"
>;

/** The scheduler claims and completes summaries but cannot read the feed or acknowledge updates. */
export type UpdateSummaryStore = Pick<
  UpdateRepository,
  "pendingSummaries" | "claimSummary" | "finishSummary"
>;
