import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import type { ArtifactLibrary } from "../interface/artifact-library.js";

const LibraryContext = createContext<ArtifactLibrary | null>(null);

/** Supply the artifact library through an interface to keep pages independent of HTTP. */
export function ArtifactLibraryProvider({
  library,
  children,
}: {
  library: ArtifactLibrary;
  children: ReactNode;
}) {
  return (
    <LibraryContext.Provider value={library}>
      {children}
    </LibraryContext.Provider>
  );
}

/** Resolve the library supplied at the composition root. */
export function useArtifactLibrary(): ArtifactLibrary {
  const library = useContext(LibraryContext);
  if (!library) throw new Error("ArtifactLibraryProvider is required");
  return library;
}

/** Keep app queries and mutations scoped to the signed-in account. */
export function useArtifactQueryKey() {
  const { profile } = useSession();
  return ["artifacts", profile?.subject] as const;
}

/** Refresh apps while this page is open so teammate actions and runtime changes remain visible. */
export function useArtifacts() {
  const library = useArtifactLibrary();
  const queryKey = useArtifactQueryKey();
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => library.list(signal),
    enabled: !!queryKey[1],
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
}
