import type { Agent } from "@everything/agent-contracts";
import type { ChatMessage } from "@everything/conversation-contracts";
import type { Update } from "@everything/update-contracts";
import { teammateAvatar } from "../../agent/model/teammate-avatars.js";
import { messagePath } from "../../update/model/update-presentation.js";
import type {
  DesktopNotificationContent,
  DesktopNotifications,
  ShownDesktopNotification,
} from "../interface/desktop-notifications.js";
import { DeliveryHighWater } from "../model/delivery-high-water.js";
import { notificationPreview } from "../model/notification-preview.js";
import type { NotificationClaimStore } from "./notification-claims.js";

/** More new messages than this in one observation become a single notification. */
export const notificationBurstSize = 3;
/** Notifications this tab keeps open; older ones close, so every open one can still be closed. */
const openNotificationsMax = 20;
const applicationIcon = "/brand/icon-192.png";

/**
 * A delivered teammate message, however it was observed. Both the update feed and an open chat
 * identify it by its message ID, so the same message is claimed under the same key either way.
 */
interface DeliveredMessage {
  readonly agentId: string;
  readonly messageId: string;
  /** Delivered text, or the update's summary or preview. */
  readonly text: string;
}

/** What the notifier needs from the browser and the application. */
export interface DeliveryNotifierOptions {
  readonly notifications: DesktopNotifications;
  readonly claims: NotificationClaimStore;
  /** Whether the user is looking at this teammate's chat right now, in any tab. */
  attending(agentId: string): boolean;
  /** Bring this window forward and show a page. */
  open(path: string): void;
  readonly now?: () => number;
}

/**
 * Notify about teammate messages as they're delivered, while desktop notifications are on.
 *
 * Deliveries arrive from two places. The unread update feed covers every teammate. An open chat
 * reports its own replies, because it marks them read as soon as they arrive, often before the
 * feed is checked again. Each place takes its first page fetched after it started (activation for
 * the feed, opening for a chat) as a baseline, so history, cached pages, reloads, and reconnects
 * never notify; only messages delivered afterward do. A message is
 * claimed once by its ID across both places and every tab, then either shown or, when the user
 * is looking at that teammate's chat, quietly skipped. User messages and other update kinds
 * never notify, and nothing here sends read receipts.
 */
export class DeliveryNotifier {
  // ===========================================
  // State
  // ===========================================
  private activeSince: number | undefined;
  /** Changes on every activation and deactivation; deliveries from an earlier one are dropped. */
  private generation = 0;
  private readonly feed = new DeliveryHighWater();
  /** Chats open in this tab, with when each opened and what it has delivered since. */
  private readonly conversations = new Map<
    string,
    { readonly openedAt: number; readonly highWater: DeliveryHighWater }
  >();
  /** Notifications this tab showed, with the teammate each one is about. */
  private readonly shown = new Map<
    ShownDesktopNotification,
    string | undefined
  >();
  private failed = false;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  /** Collaborators are supplied so the policy can be tested without a browser. */
  constructor(private readonly options: DeliveryNotifierOptions) {
    this.now = options.now ?? Date.now;
  }

  // ===========================================
  // Activation
  // ===========================================

  /** Whether notifications are on: supported, allowed, and chosen by the signed-in user. */
  get active(): boolean {
    return this.activeSince !== undefined;
  }

  /** Start notifying; the first feed check after this becomes the baseline. */
  activate(): void {
    if (this.active) return;
    this.generation++;
    this.activeSince = this.now();
    this.feed.reset();
    this.setFailed(false);
  }

  /** Stop notifying and close this tab's notifications, such as on sign-out or turning them off. */
  deactivate(): void {
    this.generation++;
    this.activeSince = undefined;
    this.feed.reset();
    for (const notification of this.shown.keys()) notification.close();
    this.shown.clear();
  }

  // ===========================================
  // Observing deliveries
  // ===========================================

  /**
   * Check the newest unread updates. A page fetched before activation is ignored, so a cached
   * page can't become the baseline and replay what was delivered while notifications were off.
   */
  async observeFeed(
    updates: readonly Update[],
    fetchedAt: number,
    agents: readonly Agent[],
  ): Promise<void> {
    if (this.activeSince === undefined || fetchedAt < this.activeSince) return;
    const deliveries = this.feed
      .observe(updates)
      .flatMap((update): DeliveredMessage[] =>
        update.kind === "message"
          ? [
              {
                agentId: update.agentId,
                messageId: update.messageId,
                text: update.summary,
              },
            ]
          : [],
      );
    await this.deliver(deliveries, agents);
  }

  /** Start following a chat opened in this tab, replacing any earlier baseline. */
  openConversation(agentId: string): void {
    this.conversations.set(agentId, {
      openedAt: this.now(),
      highWater: new DeliveryHighWater(),
    });
  }

  /**
   * Check the latest messages of a chat open in this tab. A page fetched before the chat opened,
   * such as cached history shown on returning to a teammate, is ignored; the first page fetched
   * afterward is the baseline. Later replies notify while notifications are on, and are only
   * recorded while they're off.
   */
  async observeConversation(
    agent: Agent,
    messages: readonly ChatMessage[],
    fetchedAt: number,
  ): Promise<void> {
    const conversation = this.conversations.get(agent.id);
    if (!conversation || fetchedAt < conversation.openedAt) return;
    const replies = conversation.highWater.observe(
      messages.filter((message) => message.role === "assistant"),
    );
    if (!this.active) return;
    await this.deliver(
      replies.map((message) => ({
        agentId: agent.id,
        messageId: message.id,
        text: message.text,
      })),
      [agent],
    );
  }

  /** Stop following a chat that closed; reopening it starts a new baseline. */
  forgetConversation(agentId: string): void {
    this.conversations.delete(agentId);
  }

  /** Close this tab's notifications about a teammate whose chat the user is now looking at. */
  attend(agentId: string): void {
    for (const [notification, about] of this.shown)
      if (about === agentId) {
        notification.close();
        this.shown.delete(notification);
      }
  }

  // ===========================================
  // Delivery failures
  // ===========================================

  /** Whether the browser refused the most recent notification. */
  get deliveryFailed(): boolean {
    return this.failed;
  }

  /** Follow delivery failures; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setFailed(failed: boolean): void {
    if (this.failed === failed) return;
    this.failed = failed;
    this.listeners.forEach((listener) => listener());
  }

  // ===========================================
  // Showing notifications
  // ===========================================

  /** Claim each delivery, skip those the user is looking at, and show the rest. */
  private async deliver(
    deliveries: readonly DeliveredMessage[],
    agents: readonly Agent[],
  ): Promise<void> {
    const generation = this.generation;
    const due: DeliveredMessage[] = [];
    for (const delivery of deliveries) {
      // Attention is read before claiming, so a reply the user is watching is consumed, not shown.
      const attended = this.options.attending(delivery.agentId);
      const claimed = await this.options.claims.claim(delivery.messageId);
      if (claimed && !attended) due.push(delivery);
    }
    // Turning notifications off, even if they're turned on again or another user signs in, while
    // claims were pending wins: nothing observed before that change is shown afterward.
    if (generation !== this.generation || !this.active || !due.length) return;
    if (due.length > notificationBurstSize) return this.showBurst(due, agents);
    for (const delivery of due) {
      const agent = agents.find((item) => item.id === delivery.agentId);
      this.present(
        {
          title: agent?.name ?? "Teammate",
          body: notificationPreview(delivery.text) || "Sent you a message.",
          tag: `everything-message-${delivery.messageId}`,
          icon: agent ? teammateAvatar(agent.avatarId).src : applicationIcon,
          onClick: () =>
            this.options.open(
              messagePath(delivery.agentId, delivery.messageId),
            ),
        },
        delivery.agentId,
      );
    }
  }

  /** Summarize many messages at once, such as after reconnecting, in one notification. */
  private showBurst(
    due: readonly DeliveredMessage[],
    agents: readonly Agent[],
  ): void {
    const first = due[0]!;
    const single = due.every((delivery) => delivery.agentId === first.agentId);
    const agent = agents.find((item) => item.id === first.agentId);
    this.present(
      single
        ? {
            title: agent?.name ?? "Teammate",
            body: `Sent you ${due.length} new messages.`,
            tag: `everything-messages-${first.agentId}`,
            icon: agent ? teammateAvatar(agent.avatarId).src : applicationIcon,
            onClick: () =>
              this.options.open(messagePath(first.agentId, first.messageId)),
          }
        : {
            title: "Everything",
            body: `${due.length} new messages from your teammates.`,
            tag: "everything-messages",
            icon: applicationIcon,
            onClick: () => this.options.open("/updates"),
          },
      single ? first.agentId : undefined,
    );
  }

  /** Show one notification, recording a refusal instead of failing the observation. */
  private present(
    content: DesktopNotificationContent,
    agentId: string | undefined,
  ): void {
    let shown: ShownDesktopNotification | undefined;
    try {
      shown = this.options.notifications.show({
        ...content,
        onClick: () => {
          if (shown) this.shown.delete(shown);
          content.onClick();
        },
      });
    } catch {
      this.setFailed(true);
      return;
    }
    this.setFailed(false);
    this.shown.set(shown, agentId);
    if (this.shown.size > openNotificationsMax) {
      const oldest = this.shown.keys().next().value!;
      oldest.close();
      this.shown.delete(oldest);
    }
  }
}
