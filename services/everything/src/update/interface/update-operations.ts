import type { UpdateCount, UpdatePage } from "@everything/update-contracts";

/** Owner-scoped unread updates, seen history, and acknowledgement use cases. */
export interface UpdateOperations {
  /** Read a newest-first page of unread updates without changing them. */
  list(ownerId: string, before?: string): Promise<UpdatePage>;
  /** Read a newest-first page of seen updates while preserving their original message links. */
  seen(ownerId: string, before?: string): Promise<UpdatePage>;
  /** Count the owner's unread updates in total and by teammate. */
  count(ownerId: string): Promise<UpdateCount>;
  /** Mark the updates for messages the owner saw in one teammate's conversation as read. */
  read(
    ownerId: string,
    agentId: string,
    messageIds: readonly string[],
  ): Promise<void>;
}
