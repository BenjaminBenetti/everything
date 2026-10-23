import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import { usageFollower } from "../../artifact/model/credential-presentation.js";
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

/**
 * Read which apps receive a generic credential while a dialog shows it. With `follow`, keep
 * polling until every app has settled, so a restart is never reported as finished early, and keep
 * retrying with a growing delay while usage can't be read. With `observation`, reads go to a query
 * of their own, so only reads started for that observation count: a read that began earlier, such
 * as one from before a replacement was saved, can never answer it.
 */
export function useCredentialUsage(
  id: string,
  follow = false,
  observation?: string,
) {
  const directory = useKeyDirectory();
  const { profile } = useSession();
  const [follower] = useState(usageFollower);
  return useQuery({
    queryKey: [
      "keys",
      profile?.subject,
      id,
      "apps",
      ...(observation ? [observation] : []),
    ],
    queryFn: ({ signal }) => directory.usage(id, signal),
    enabled: !!profile,
    staleTime: 0,
    refetchInterval: (query) => follow && follower(query.state),
    retry: false,
  });
}
