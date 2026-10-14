/** Message limits shared by the composer, API, persistence, and reply tool. */
export const messageTextMaxLength = 32000;
export const messagePageSize = 100;
export const updatePageSize = 50;
export const readReceiptMaxSize = 100;

/** A grounded preview of one unread, user-visible teammate message. */
export interface MessageUpdate {
  readonly messageId: string;
  readonly agentId: string;
  readonly summary: string;
  readonly createdAt: string;
}

/** Newest-first unread messages; the cursor remains valid after a message is read. */
export interface UpdatePage {
  readonly updates: MessageUpdate[];
  readonly nextCursor: string | null;
}

/** One saved message in a teammate's ongoing conversation. */
export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

/** A chronological history page; the opaque cursor loads the preceding page. */
export interface MessagePage {
  readonly messages: ChatMessage[];
  readonly nextCursor: string | null;
}

/** Acknowledgement after saving input and starting the teammate's turn. */
export interface MessageReceipt {
  readonly messageId: string;
  readonly runId: string;
}

/** Safe execution status; runtime identifiers never represent user-selectable conversations. */
export interface RuntimeStatus {
  readonly status: "idle" | "running" | "error";
  readonly compacting: boolean;
  /** Whether the teammate is writing a message to the user right now. */
  readonly typing: boolean;
  /** Background teammates running now or idle for less than ten seconds; excludes the main session. */
  readonly backgroundCount: number;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly error: string | null;
}
