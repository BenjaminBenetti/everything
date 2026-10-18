import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMatch } from "react-router-dom";
import { useAgents } from "../../agent/component/agent-directory-provider.js";
import { useSession } from "../../session/component/session-provider.js";
import { useUpdateClient } from "../../update/component/update-provider.js";
import { updateQueryRoot } from "../../update/hook/use-updates.js";
import { useDesktopNotificationServices } from "../component/desktop-notification-provider.js";
import { useNotificationsEnabled } from "./use-desktop-notification-state.js";

/** How often the feed is checked while notifications are on, including in background tabs. */
const feedInterval = 5_000;
/** How often a tab showing a chat renews its shared attention record, well within its lifetime. */
const attentionInterval = 3_000;

/**
 * Run desktop notifications for the signed-in user: activate them while they're on, check the
 * unread feed in visible and background tabs, and share which chat the user is looking at.
 * Nothing runs, and no extra requests are made, while notifications are off.
 */
export function useDeliveryNotifications(): void {
  const { attention, notifier } = useDesktopNotificationServices();
  const { profile } = useSession();
  const client = useUpdateClient();
  const agents = useAgents().data;
  const latestAgents = useRef(agents ?? []);
  latestAgents.current = agents ?? [];
  const enabled = useNotificationsEnabled();
  const openAgentId = useMatch("/team/:agentId")?.params.agentId;

  // Activate before reading the feed, so a page cached from earlier can't become the baseline.
  useEffect(() => {
    if (!enabled) return;
    notifier.activate();
    return () => notifier.deactivate();
  }, [enabled, notifier]);

  const feed = useQuery({
    queryKey: [...updateQueryRoot, profile?.subject, "notifications"],
    queryFn: ({ signal }) => client.list(undefined, signal),
    enabled: enabled && !!profile,
    refetchInterval: feedInterval,
    // Notifications matter most while the user is in another tab or app.
    refetchIntervalInBackground: true,
    retry: false,
  });
  useEffect(() => {
    if (feed.data)
      void notifier.observeFeed(
        feed.data.updates,
        feed.dataUpdatedAt,
        latestAgents.current,
      );
  }, [feed.data, feed.dataUpdatedAt, notifier]);

  useEffect(() => {
    if (!enabled) return;
    attention.show(openAgentId);
    /** Share attention and close notifications about the chat the user is now looking at. */
    const refresh = () => {
      attention.publish();
      const attended = attention.attendedAgent();
      if (attended) notifier.attend(attended);
    };
    /** Leaving the window ends attention immediately, before focus can be checked again. */
    const leave = () => attention.withdraw();
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", refresh);
    const heartbeat = window.setInterval(refresh, attentionInterval);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(heartbeat);
      attention.show(undefined);
      attention.withdraw();
    };
  }, [attention, enabled, notifier, openAgentId]);
}
