import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMatch } from "react-router-dom";
import { useSession } from "../../session/component/session-provider.js";
import { useUpdateClient } from "../component/update-provider.js";

/** Every update query starts with this key, so one invalidation refreshes the feed and all badges. */
export const updateQueryRoot = ["updates"] as const;

/** Keep unread and seen pages separate while receipts and preference changes invalidate both. */
export function useUpdates(seen = false) {
  const client = useUpdateClient();
  const { profile } = useSession();
  return useInfiniteQuery({
    queryKey: [
      ...updateQueryRoot,
      profile?.subject,
      "feed",
      seen ? "seen" : "unread",
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      seen ? client.seen(pageParam, signal) : client.list(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!profile,
    staleTime: 5_000,
    refetchInterval: seen ? false : 5_000,
    retry: false,
  });
}

/** Keep the open chat quiet while retaining other teammates' unread badges and the server's full counts. */
export function useUpdateCount() {
  const client = useUpdateClient();
  const { profile } = useSession();
  const openAgentId = useMatch("/team/:agentId")?.params.agentId;
  return useQuery({
    queryKey: [...updateQueryRoot, profile?.subject, "count"],
    queryFn: ({ signal }) => client.count(signal),
    select: (count) => {
      if (!openAgentId) return count;
      const { [openAgentId]: openCount = 0, ...byAgent } = count.byAgent;
      return { unread: Math.max(0, count.unread - openCount), byAgent };
    },
    enabled: !!profile,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
}
