import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@everything/agent-contracts";
import { useAgentDirectory } from "./agent-directory-provider.js";
import { useSession } from "../../session/component/session-provider.js";
import { ModelInfoContent } from "./model-info-content.js";

/** Resolve on opening or profile changes, never by inference or a frontend static lookup. */
export function AgentModelDetails({ agent }: { agent: Agent }) {
  const directory = useAgentDirectory();
  const { profile } = useSession();
  const query = useQuery({
    queryKey: [
      "agent-model-info",
      profile?.subject,
      agent.id,
      agent.name,
      agent.systemPrompt,
      agent.inference,
    ],
    queryFn: ({ signal }) => directory.modelInfo(agent.id, signal),
    enabled: !!profile,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  return (
    <ModelInfoContent
      info={query.data}
      pending={query.isFetching || query.isPending}
      error={query.isError}
    />
  );
}
