import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessagePage } from "@everything/conversation-contracts";
import { useSession } from "../../session/component/session-provider.js";
import { useConversationClient } from "../component/conversation-provider.js";
import { prependHistory, refreshHistory } from "../model/message-history.js";
import { useRecordAgentInteraction } from "../../agent/hook/use-recent-agents.js";

/** Coordinate history and progress, keeping the background indicator current through its idle grace period. */
export function useConversation(agentId: string, targetMessageId?: string) {
  const client = useConversationClient();
  const { profile } = useSession();
  const queries = useQueryClient();
  useRecordAgentInteraction(agentId);
  const [history, setHistory] = useState<MessagePage>();
  const searchedCursor = useRef<string | undefined>(undefined);
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
    // Keep polling every second while a displayed background count is waiting to expire.
    refetchInterval: (query) => {
      const runtime = query.state.data?.runtime;
      return runtime?.status === "running" ||
        (runtime?.backgroundCount ?? 0) > 0
        ? 1000
        : 5000;
    },
  });
  useEffect(() => {
    if (snapshot.data)
      setHistory((current) => refreshHistory(current, snapshot.data.page));
  }, [snapshot.data]);
  const send = useMutation({
    mutationFn: (text: string) => client.send(agentId, text),
    retry: false,
    /** Refresh saved input, progress, and recency after the message has been persisted. */
    onSuccess: () => {
      void snapshot.refetch();
      void queries.invalidateQueries({
        queryKey: ["agents", profile?.subject, "recent"],
      });
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
  const targetFound = !!history?.messages.some(
    (message) => message.id === targetMessageId,
  );
  useEffect(() => {
    searchedCursor.current = undefined;
  }, [targetMessageId]);
  useEffect(() => {
    const cursor = history?.nextCursor;
    if (
      !targetMessageId ||
      targetFound ||
      !cursor ||
      older.isPending ||
      older.isError ||
      searchedCursor.current === cursor
    )
      return;
    searchedCursor.current = cursor;
    older.mutate(cursor);
  }, [
    history,
    targetMessageId,
    targetFound,
    older.isPending,
    older.isError,
    older.mutate,
  ]);
  return {
    history,
    snapshot,
    send,
    older,
    targetFound,
    /** Allow an interrupted deep-link lookup to resume at the last durable history cursor. */
    retryTarget: () => {
      searchedCursor.current = undefined;
      older.reset();
    },
  };
}
