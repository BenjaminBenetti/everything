import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { workspaceActivityPolicy } from "@everything/workspace-contracts/activity";
import {
  useWorkspaceDirectory,
  useWorkspaceQueryKey,
} from "../component/workspace-directory-provider.js";

/** Poll only the open chat and expire activity locally even if the next request fails. */
export function useWorkspaceActivity(agentId: string) {
  const directory = useWorkspaceDirectory();
  const key = useWorkspaceQueryKey();
  const query = useQuery({
    queryKey: [...key, "activity", agentId],
    queryFn: ({ signal }) => directory.recent(agentId, signal),
    enabled: !!key[1],
    staleTime: 1_000,
    refetchInterval: 1_000,
    retry: false,
  });
  const [now, setNow] = useState(Date.now);
  const observedAt = Date.parse(query.data?.observedAt ?? "");
  const workspaces = (query.data?.workspaces ?? []).map((workspace) => ({
    ...workspace,
    // Translate server-relative age to the browser clock when each response arrives.
    activeUntil:
      query.dataUpdatedAt +
      Date.parse(workspace.lastInteractedAt) +
      workspaceActivityPolicy.activeMilliseconds -
      observedAt,
  }));
  const nextExpiry = Math.min(
    ...workspaces.map((item) => item.activeUntil).filter((at) => at > now),
  );
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, nextExpiry - Date.now()) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);
  return {
    query,
    workspaces: workspaces.map(({ activeUntil, ...workspace }) => ({
      ...workspace,
      active: activeUntil > Math.max(now, Date.now()),
    })),
  };
}
