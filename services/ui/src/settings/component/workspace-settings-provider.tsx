import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkerSettings } from "@everything/settings-contracts";
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
