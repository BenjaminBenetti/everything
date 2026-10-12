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

/** One cancellable query of the user's artifacts, refreshed while running apps start. */
export function useArtifacts() {
  const library = useArtifactLibrary();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["artifacts", profile?.subject],
    queryFn: ({ signal }) => library.list(signal),
    enabled: !!profile,
    staleTime: 15_000,
    refetchInterval: (query) =>
      query.state.data?.some((artifact) => artifact.status === "starting")
        ? 5_000
        : false,
    retry: false,
  });
}
