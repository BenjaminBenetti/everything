import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import { useUpdateClient } from "../component/update-provider.js";

/** Every update query starts with this key, so one invalidation refreshes the feed and the badge. */
export const updateQueryRoot = ["updates"] as const;

/** Share a persistent server-backed feed across Home and Updates; reconnects only fetch. */
export function useUpdates() {
  const client = useUpdateClient();
  const { profile } = useSession();
  return useInfiniteQuery({
    queryKey: [...updateQueryRoot, profile?.subject, "feed"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => client.list(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!profile,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
}

/** Poll the unread total while the page is visible; a failed count shows no badge rather than an error. */
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
