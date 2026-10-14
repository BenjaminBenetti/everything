import { useInfiniteQuery } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import { useConversationClient } from "../../conversation/component/conversation-provider.js";

/** Share a persistent server-backed feed across Home and Updates; reconnects only fetch. */
export function useUpdates() {
  const client = useConversationClient();
  const { profile } = useSession();
  return useInfiniteQuery({
    queryKey: ["updates", profile?.subject],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => client.updates(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!profile,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
}
