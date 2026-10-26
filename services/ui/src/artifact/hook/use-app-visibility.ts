import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ArtifactSummary,
  ArtifactVisibility,
} from "@everything/artifact-contracts";
import {
  useArtifactLibrary,
  useArtifactQueryKey,
} from "../component/artifact-library-provider.js";

/** Change who can open the app, then show the app exactly as the server saved it. */
export function useAppVisibility(app: ArtifactSummary) {
  const library = useArtifactLibrary();
  const queryKey = useArtifactQueryKey();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (visibility: ArtifactVisibility) =>
      library.setVisibility(app.id, visibility),
    onMutate: () => cache.cancelQueries({ queryKey }),
    onSuccess: async (saved) => {
      await cache.cancelQueries({ queryKey });
      cache.setQueryData<readonly ArtifactSummary[]>(queryKey, (items) =>
        items?.map((item) => (item.id === saved.id ? saved : item)),
      );
    },
    onSettled: () => cache.invalidateQueries({ queryKey }),
  });
}
