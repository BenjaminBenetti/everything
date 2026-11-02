import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import type { AgentDirectory } from "../interface/agent-directory.js";
import { ModelContextCache } from "../service/model-context-cache.js";

const DirectoryContext = createContext<{
  directory: AgentDirectory;
  contexts: ModelContextCache;
} | null>(null);

/** Supply the directory through an interface to keep pages independent of HTTP. */
export function AgentDirectoryProvider({
  directory,
  children,
  contextCache,
}: {
  directory: AgentDirectory;
  children: ReactNode;
  contextCache?: ModelContextCache;
}) {
  const [contexts] = useState(() => contextCache ?? new ModelContextCache());
  const { profile, loading } = useSession();
  const queries = useQueryClient();
  const previousOwner = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Initial session restoration must not erase the persisted owner before a full reload completes.
    if (loading) return;
    const owner = profile?.subject;
    if (previousOwner.current !== owner) {
      void queries.cancelQueries({
        queryKey: ["agent-context", previousOwner.current],
      });
      queries.removeQueries({
        queryKey: ["agent-context", previousOwner.current],
      });
    }
    if (owner) contexts.activate(owner);
    else {
      contexts.clear();
      queries.removeQueries({ queryKey: ["agent-context"] });
    }
    previousOwner.current = owner;
  }, [contexts, queries, loading, profile?.subject]);
  return (
    <DirectoryContext.Provider value={{ directory, contexts }}>
      {children}
    </DirectoryContext.Provider>
  );
}

/** Resolve the directory supplied at the composition root. */
export function useAgentDirectory(): AgentDirectory {
  const directory = useContext(DirectoryContext);
  if (!directory) throw new Error("AgentDirectoryProvider is required");
  return directory.directory;
}

/** Share the owner-scoped persisted context service with rows and provider-edit invalidation. */
export function useModelContextCache(): ModelContextCache {
  const value = useContext(DirectoryContext);
  if (!value) throw new Error("AgentDirectoryProvider is required");
  return value.contexts;
}

/** Share one cancellable, owner-scoped query between the shell and team page. */
export function useAgents() {
  const directory = useAgentDirectory();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["agents", profile?.subject],
    queryFn: ({ signal }) => directory.list(signal),
    enabled: !!profile,
    staleTime: 30_000,
    retry: false,
  });
}
