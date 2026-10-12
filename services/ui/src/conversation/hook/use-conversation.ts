import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { MessagePage } from "@everything/conversation-contracts";
import { useSession } from "../../session/component/session-provider.js";
import { useConversationClient } from "../component/conversation-provider.js";
import { prependHistory, refreshHistory } from "../model/message-history.js";

/** Coordinate polling, explicit submissions, and history pages within one mounted teammate. */
export function useConversation(agentId: string) {
  const client = useConversationClient();
  const { profile } = useSession();
  const [history, setHistory] = useState<MessagePage>();
  const snapshot = useQuery({
    queryKey: ["conversation", profile?.subject, agentId],
    /** Read progress first so an idle result is followed by all committed replies. */
    queryFn: async ({ signal }) => {
      const runtime = await client.status(agentId, signal);
      const page = await client.history(agentId, undefined, signal);
      return { runtime, page };
    },
    enabled: !!profile,
    retry: false,
    // While the teammate works, check every second so its typing indicator appears as it writes.
    refetchInterval: (query) =>
      query.state.data?.runtime.status === "running" ? 1000 : 5000,
  });
  useEffect(() => {
    if (snapshot.data)
      setHistory((current) => refreshHistory(current, snapshot.data.page));
  }, [snapshot.data]);
  const send = useMutation({
    mutationFn: (text: string) => client.send(agentId, text),
    retry: false,
    /** Refresh the saved input and progress after the POST has been acknowledged. */
    onSuccess: () => {
      void snapshot.refetch();
    },
  });
  const older = useMutation({
    mutationFn: (cursor: string) => client.history(agentId, cursor),
    retry: false,
    /** Ignore an old page if a disjoint live refresh has replaced its pagination boundary. */
    onSuccess: (page, cursor) =>
      setHistory((current) =>
        current?.nextCursor === cursor
          ? prependHistory(current, page)
          : current,
      ),
  });
  return { history, snapshot, send, older };
}
