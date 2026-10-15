import type { UpdateCount, UpdatePage } from "@everything/update-contracts";

/** Browser capabilities for the owner's unread updates and seen history, independent of HTTP. */
export interface UpdateClient {
  /** Read unread updates newest first, continuing after an update ID, without marking anything read. */
  list(before?: string, signal?: AbortSignal): Promise<UpdatePage>;
  /** Read older seen updates without changing their receipts or unread counts. */
  seen(before?: string, signal?: AbortSignal): Promise<UpdatePage>;
  /** Count unread updates for navigation without loading their content. */
  count(signal?: AbortSignal): Promise<UpdateCount>;
}
