import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import type { AgentDirectory } from "../interface/agent-directory.js";

const DirectoryContext = createContext<AgentDirectory | null>(null);

/** Supply the directory through an interface to keep pages independent of HTTP. */
export function AgentDirectoryProvider({
  directory,
  children,
}: {
  directory: AgentDirectory;
  children: ReactNode;
}) {
  return (
    <DirectoryContext.Provider value={directory}>
      {children}
    </DirectoryContext.Provider>
  );
}

/** Resolve the directory supplied at the composition root. */
export function useAgentDirectory(): AgentDirectory {
  const directory = useContext(DirectoryContext);
  if (!directory) throw new Error("AgentDirectoryProvider is required");
  return directory;
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
