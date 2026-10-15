import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArtifactSummary } from "@everything/artifact-contracts";
import {
  useArtifactLibrary,
  useArtifactQueryKey,
} from "../component/artifact-library-provider.js";

/** Lifecycle actions available to the app's owner. */
export type AppAction = "start" | "stop" | "delete";

/** Serialize this card's actions and reconcile the owner's cached app list after each request. */
export function useAppAction(app: ArtifactSummary, onComplete: () => void) {
  const library = useArtifactLibrary();
  const queryKey = useArtifactQueryKey();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (action: AppAction) => library[action](app.id),
    onMutate: () => cache.cancelQueries({ queryKey }),
    onSuccess: async (_result, action) => {
      await cache.cancelQueries({ queryKey });
      onComplete();
      cache.setQueryData<readonly ArtifactSummary[]>(queryKey, (items) =>
        action === "delete"
          ? items?.filter((item) => item.id !== app.id)
          : items?.map((item) =>
              item.id === app.id
                ? {
                    ...item,
                    status:
                      action === "stop"
                        ? "stopped"
                        : item.kind === "static"
                          ? "live"
                          : "starting",
                    updatedAt: new Date().toISOString(),
                    updatedBy: { id: queryKey[1]!, name: "You" },
                  }
                : item,
            ),
      );
    },
    onSettled: () => cache.invalidateQueries({ queryKey }),
  });
}
