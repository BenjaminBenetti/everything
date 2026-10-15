import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import { useAgentDirectory } from "../component/agent-directory-provider.js";

/** Share recent teammates by owner, including changes from another device when Home is reopened. */
export function useRecentAgents() {
  const directory = useAgentDirectory();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["agents", profile?.subject, "recent"],
    queryFn: ({ signal }) => directory.recent(signal),
    enabled: !!profile,
    staleTime: 0,
    retry: false,
  });
}

/** Record a visit once on entering a valid teammate page; chat polling never renews recency. */
export function useRecordAgentInteraction(agentId: string) {
  const directory = useAgentDirectory();
  const { profile } = useSession();
  const queries = useQueryClient();
  const { mutate } = useMutation({
    mutationFn: () => directory.touch(agentId),
    onSuccess: () =>
      queries.invalidateQueries({
        queryKey: ["agents", profile?.subject, "recent"],
      }),
    retry: false,
  });
  useEffect(() => {
    if (profile) mutate();
  }, [agentId, profile?.subject, mutate]);
}
