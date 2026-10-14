import type { UpdatePage } from "@everything/conversation-contracts";

/** Owner-scoped unread delivery and acknowledgement use cases. */
export interface UpdateOperations {
  list(ownerId: string, before?: string): Promise<UpdatePage>;
  read(
    ownerId: string,
    agentId: string,
    messageIds: readonly string[],
  ): Promise<void>;
}
