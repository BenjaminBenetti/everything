import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GeneralSettings,
  TeammateOrder,
  WorkerSettings,
} from "@everything/settings-contracts";
import { updateQueryRoot } from "../../update/hook/use-updates.js";
import { useSession } from "../../session/component/session-provider.js";
import type { WorkspaceSettings } from "../interface/workspace-settings.js";

const SettingsContext = createContext<WorkspaceSettings | null>(null);

/** Supply workspace settings through an interface to keep components independent of HTTP. */
export function WorkspaceSettingsProvider({
  settings,
  children,
}: {
  settings: WorkspaceSettings;
  children: ReactNode;
}) {
  return (
    <SettingsContext.Provider value={settings}>
      {children}
    </SettingsContext.Provider>
  );
}

/** Resolve the settings supplied at the composition root. */
function useWorkspaceSettings(): WorkspaceSettings {
  const settings = useContext(SettingsContext);
  if (!settings) throw new Error("WorkspaceSettingsProvider is required");
  return settings;
}

/** Refresh general settings whenever the dialog opens. */
export function useGeneralSettings() {
  const settings = useWorkspaceSettings();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["general-settings", profile?.subject],
    queryFn: ({ signal }) => settings.general(signal),
    enabled: !!profile,
    staleTime: 0,
    retry: false,
  });
}

/** Save the preference and immediately refresh update cards to reflect it. */
export function useUpdateGeneralSettings() {
  const settings = useWorkspaceSettings();
  const { profile } = useSession();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (next: GeneralSettings) => settings.updateGeneral(next),
    onSuccess: async (saved) => {
      queries.setQueryData(["general-settings", profile?.subject], saved);
      await queries.invalidateQueries({
        queryKey: [...updateQueryRoot, profile?.subject, "feed"],
      });
    },
  });
}

/** Share the owner's teammate order between navigation and the team page. */
export function useTeammateOrder() {
  const settings = useWorkspaceSettings();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["teammate-order", profile?.subject],
    queryFn: ({ signal }) => settings.teammateOrder(signal),
    enabled: !!profile,
    staleTime: 30_000,
    retry: false,
  });
}

/** Show a new teammate order at once, save drops in sequence, and restore the saved order if a save fails. */
export function useSaveTeammateOrder() {
  const settings = useWorkspaceSettings();
  const { profile } = useSession();
  const queries = useQueryClient();
  const queryKey = ["teammate-order", profile?.subject];
  return useMutation({
    mutationKey: queryKey,
    scope: { id: `teammate-order:${profile?.subject}` },
    mutationFn: (next: TeammateOrder) => settings.updateTeammateOrder(next),
    onMutate: async (next) => {
      await queries.cancelQueries({ queryKey });
      const previous = queries.getQueryData<TeammateOrder>(queryKey);
      queries.setQueryData(queryKey, next);
      return { previous };
    },
    onSuccess: (saved) => {
      // An earlier save finishing must not replace a newer order that is still saving.
      if (queries.isMutating({ mutationKey: queryKey }) === 1)
        queries.setQueryData(queryKey, saved);
    },
    onError: async (_error, _next, context) => {
      // A queued save already includes this move, so only the last one restores the saved order.
      if (queries.isMutating({ mutationKey: queryKey }) > 1) return;
      if (context?.previous) queries.setQueryData(queryKey, context.previous);
      await queries.invalidateQueries({ queryKey });
    },
  });
}

/** The worker settings, read once per dialog opening. */
export function useWorkerSettings() {
  const settings = useWorkspaceSettings();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["worker-settings", profile?.subject],
    queryFn: ({ signal }) => settings.workers(signal),
    enabled: !!profile,
    staleTime: 0,
    retry: false,
  });
}

/** Change the worker settings and show the values the server reports afterwards. */
export function useUpdateWorkerSettings() {
  const settings = useWorkspaceSettings();
  const { profile } = useSession();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (next: WorkerSettings) => settings.updateWorkers(next),
    onSuccess: (saved) =>
      queries.setQueryData(["worker-settings", profile?.subject], saved),
  });
}
