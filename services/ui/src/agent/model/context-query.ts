import { queryOptions } from "@tanstack/react-query";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import type { AgentDirectory } from "../interface/agent-directory.js";
import { matchingContext } from "./context-budget.js";
import {
  contextFreshMs,
  type ContextScope,
  type ModelContextCache,
} from "../service/model-context-cache.js";

/** Shared by the actual row and observer integration tests: restore data and its original timestamp. */
export function contextQueryOptions(
  directory: Pick<AgentDirectory, "modelInfo">,
  cache: ModelContextCache,
  scope: ContextScope,
  selection: InferenceSelection,
) {
  const cached = cache.read(scope);
  return queryOptions({
    queryKey: [
      "agent-context",
      scope.owner,
      scope.provider,
      scope.agentId,
      scope.revision,
    ],
    queryFn: async ({ signal }) => {
      const info = await directory.modelInfo(scope.agentId, signal);
      const tokens = matchingContext(info, selection);
      if (tokens === undefined) throw new Error("Context metadata unavailable");
      cache.write(scope, tokens);
      return tokens;
    },
    ...(cached
      ? { initialData: cached.tokens, initialDataUpdatedAt: cached.updatedAt }
      : {}),
    staleTime: contextFreshMs,
    gcTime: contextFreshMs,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
