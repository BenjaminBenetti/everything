import type { TeammateOrder } from "@everything/settings-contracts";

/** Arrange only the teammates belonging to an authenticated owner. */
export interface TeammateOrderOperations {
  /** Return the saved order, or an empty order when the owner never rearranged their team. */
  read(ownerId: string): Promise<TeammateOrder>;
  /** Save the owner's order and return it, leaving their other preferences unchanged. */
  update(ownerId: string, order: TeammateOrder): Promise<TeammateOrder>;
}
