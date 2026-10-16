import type { MessagePage } from "@everything/conversation-contracts";

/** Native transcript access used by a live session family. */
export interface SessionForkHistory {
  /** Read safe text after the fork boundary, excluding inherited main conversation context. */
  messages(id: string, before?: string): MessagePage;
  /** Remove already stopped sessions by their known IDs, never caller-provided paths. */
  remove(ids: readonly string[]): Promise<void>;
}
