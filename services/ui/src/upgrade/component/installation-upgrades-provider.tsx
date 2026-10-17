import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import type { InstallationUpgrades } from "../interface/installation-upgrades.js";

/** Status checks repeat this often while an upgrade runs. */
const followIntervalMs = 3_000;

const UpgradesContext = createContext<InstallationUpgrades | null>(null);

/** Supply installation upgrades through an interface to keep components independent of HTTP. */
export function InstallationUpgradesProvider({
  upgrades,
  children,
}: {
  upgrades: InstallationUpgrades;
  children: ReactNode;
}) {
  return (
    <UpgradesContext.Provider value={upgrades}>
      {children}
    </UpgradesContext.Provider>
  );
}

/** Resolve the upgrades supplied at the composition root. */
function useInstallationUpgrades(): InstallationUpgrades {
  const upgrades = useContext(UpgradesContext);
  if (!upgrades) throw new Error("InstallationUpgradesProvider is required");
  return upgrades;
}

/**
 * The upgrade status, read whenever the settings open and followed while an upgrade runs. Everything
 * restarts partway through an upgrade, so checks fail for a while; the last status stays shown.
 */
export function useUpgradeStatus() {
  const upgrades = useInstallationUpgrades();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["upgrade", profile?.subject],
    queryFn: ({ signal }) => upgrades.status(signal),
    enabled: !!profile,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.lastUpgrade?.state === "running"
        ? followIntervalMs
        : false,
  });
}

/** Start an upgrade and show the status the server reports for it. */
export function useStartUpgrade() {
  const upgrades = useInstallationUpgrades();
  const { profile } = useSession();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (version: string) => upgrades.start({ version }),
    onSuccess: (status) =>
      queries.setQueryData(["upgrade", profile?.subject], status),
  });
}
