import { browserStorage, type StorageAccess } from "./browser-storage.js";

const storageKey = "everything-notification-attention";
/** How long another tab trusts a shared record; the attending tab renews it more often than this. */
export const attentionLifetime = 10_000;

/** Whether a page is in front of the user. */
export interface DocumentAttention {
  visible(): boolean;
  focused(): boolean;
}

/** Read the real document's visibility and focus. */
export function browserDocumentAttention(): DocumentAttention {
  return {
    visible: () => document.visibilityState === "visible",
    focused: () => document.hasFocus(),
  };
}

/** The shared record of the chat the user is looking at in some tab. */
interface AttentionRecord {
  readonly tab: string;
  readonly agentId: string;
  readonly expiresAt: number;
}

/**
 * Know which teammate's chat the user is looking at, so its replies don't also notify. A chat
 * counts only while its page is visible and focused. This tab answers from the live document;
 * other tabs read a short-lived record in browser storage, which expires if this tab stops
 * renewing it without withdrawing it, for example after a crash.
 */
export class NotificationAttention {
  // ===========================================
  // Construction
  // ===========================================
  private openAgentId: string | undefined;

  /** Use the browser's document and storage unless a test supplies its own. */
  constructor(
    private readonly storage: StorageAccess = browserStorage,
    private readonly page: DocumentAttention = browserDocumentAttention(),
    private readonly now: () => number = Date.now,
    private readonly tab = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  ) {}

  // ===========================================
  // Attention
  // ===========================================

  /** Record which teammate's chat this tab shows, if any. */
  show(agentId: string | undefined): void {
    this.openAgentId = agentId;
  }

  /** The teammate whose chat the user is looking at in this tab right now. */
  attendedAgent(): string | undefined {
    return this.page.visible() && this.page.focused()
      ? this.openAgentId
      : undefined;
  }

  /** Whether the user is looking at this teammate's chat in this tab or another one. */
  attending(agentId: string): boolean {
    if (this.attendedAgent() === agentId) return true;
    const record = this.read();
    return record?.agentId === agentId && record.expiresAt > this.now();
  }

  // ===========================================
  // Sharing with other tabs
  // ===========================================

  /** Share this tab's attention, or withdraw it; call when attention may have changed and periodically. */
  publish(): void {
    const agentId = this.attendedAgent();
    if (!agentId) return this.withdraw();
    this.write({
      tab: this.tab,
      agentId,
      expiresAt: this.now() + attentionLifetime,
    });
  }

  /** Remove this tab's record, leaving one written since by another tab. */
  withdraw(): void {
    if (this.read()?.tab !== this.tab) return;
    try {
      this.storage()?.removeItem(storageKey);
    } catch {
      /* Storage is optional; the record expires. */
    }
  }

  /** Read and validate the shared record. */
  private read(): AttentionRecord | undefined {
    try {
      const value: unknown = JSON.parse(
        this.storage()?.getItem(storageKey) ?? "null",
      );
      if (
        value &&
        typeof value === "object" &&
        "tab" in value &&
        "agentId" in value &&
        "expiresAt" in value &&
        typeof value.tab === "string" &&
        typeof value.agentId === "string" &&
        typeof value.expiresAt === "number"
      )
        return {
          tab: value.tab,
          agentId: value.agentId,
          expiresAt: value.expiresAt,
        };
    } catch {
      /* A missing or malformed record means no other tab is attending. */
    }
    return undefined;
  }

  /** Save the shared record, if storage allows. */
  private write(record: AttentionRecord): void {
    try {
      this.storage()?.setItem(storageKey, JSON.stringify(record));
    } catch {
      /* Storage is optional; other tabs then notify as if no one were looking. */
    }
  }
}
