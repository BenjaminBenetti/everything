import { useEffect } from "react";
import type { Agent } from "@everything/agent-contracts";
import type { ChatMessage } from "@everything/conversation-contracts";
import { useDesktopNotificationServices } from "../component/desktop-notification-provider.js";

/**
 * Report replies arriving in an open chat. The chat marks them read right away, even in a
 * background tab, so the unread feed may never see them. Cached history shown on returning to a
 * teammate is ignored; the first page fetched after the chat opens is the baseline.
 */
export function useReplyNotifications(
  agent: Agent,
  latestMessages: readonly ChatMessage[] | undefined,
  fetchedAt: number,
): void {
  const { notifier } = useDesktopNotificationServices();
  // Open before observing, so this render's cached page is recognized as older than the chat.
  useEffect(() => {
    notifier.openConversation(agent.id);
    return () => notifier.forgetConversation(agent.id);
  }, [agent.id, notifier]);
  useEffect(() => {
    if (latestMessages)
      void notifier.observeConversation(agent, latestMessages, fetchedAt);
  }, [agent, fetchedAt, latestMessages, notifier]);
}
