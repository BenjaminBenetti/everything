import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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

/** Share total and teammate counts across badges, polling while the page is visible. */
export function useUpdateCount() {
  const client = useUpdateClient();
  const { profile } = useSession();
  return useQuery({
    queryKey: [...updateQueryRoot, profile?.subject, "count"],
    queryFn: ({ signal }) => client.count(signal),
    enabled: !!profile,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
}
