import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import type { KeyDirectory } from "../interface/key-directory.js";

const KeyDirectoryContext = createContext<KeyDirectory | null>(null);

/** Inject key capabilities so pages stay independent of their HTTP implementation. */
export function KeyDirectoryProvider({
  directory,
  children,
}: {
  directory: KeyDirectory;
  children: ReactNode;
}) {
  return (
    <KeyDirectoryContext.Provider value={directory}>
      {children}
    </KeyDirectoryContext.Provider>
  );
}

/** Resolve the key directory at the composition boundary. */
export function useKeyDirectory(): KeyDirectory {
  const directory = useContext(KeyDirectoryContext);
  if (!directory) throw new Error("KeyDirectoryProvider is required");
  return directory;
}

/** Cache shared metadata within the current signed-in session and refresh runtime availability. */
export function useKeys() {
  const directory = useKeyDirectory();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["keys", profile?.subject],
    queryFn: ({ signal }) => directory.list(signal),
    enabled: !!profile,
    staleTime: 30_000,
    refetchInterval: 5000,
    retry: false,
  });
}
