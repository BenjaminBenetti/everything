import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import type { WorkspaceDirectory } from "../interface/workspace-directory.js";

const DirectoryContext = createContext<WorkspaceDirectory | null>(null);

/** Supply workspace capabilities without coupling pages to HTTP. */
export function WorkspaceDirectoryProvider({
  directory,
  children,
}: {
  directory: WorkspaceDirectory;
  children: ReactNode;
}) {
  return (
    <DirectoryContext.Provider value={directory}>
      {children}
    </DirectoryContext.Provider>
  );
}

/** Resolve the directory supplied by the composition root. */
export function useWorkspaceDirectory(): WorkspaceDirectory {
  const directory = useContext(DirectoryContext);
  if (!directory) throw new Error("WorkspaceDirectoryProvider is required");
  return directory;
}

/** Keep runtime data partitioned by the current signed-in account. */
export function useWorkspaceQueryKey() {
  const { profile } = useSession();
  return ["workspaces", profile?.subject] as const;
}

/** Refresh resource usage and changes made by teammates while this page is open. */
export function useWorkspaces() {
  const directory = useWorkspaceDirectory();
  const queryKey = useWorkspaceQueryKey();
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => directory.list(signal),
    enabled: !!queryKey[1],
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
}
