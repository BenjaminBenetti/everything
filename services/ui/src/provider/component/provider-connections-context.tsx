import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProviderConnection,
  ProviderId,
} from "@everything/provider-contracts";
import { useSession } from "../../session/component/session-provider.js";
import type { ProviderConnections } from "../interface/provider-connections.js";

const ConnectionsContext = createContext<ProviderConnections | null>(null);

/** Supply connection management without tying components to HTTP. */
export function ProviderConnectionsProvider({
  connections,
  children,
}: {
  connections: ProviderConnections;
  children: ReactNode;
}) {
  return (
    <ConnectionsContext.Provider value={connections}>
      {children}
    </ConnectionsContext.Provider>
  );
}

/** Resolve the injected provider capability. */
export function useProviderConnections(): ProviderConnections {
  const connections = useContext(ConnectionsContext);
  if (!connections) throw new Error("ProviderConnectionsProvider is required");
  return connections;
}

/** Poll persisted connection results; the server schedules daily checks independently of the UI. */
export function useProviders() {
  const connections = useProviderConnections();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["providers", profile?.subject],
    queryFn: ({ signal }) => connections.list(signal),
    enabled: !!profile,
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

/** Invalidate previous green state while an explicit edit or check is in progress. */
export function useProviderAction(provider: ProviderId) {
  const cache = useQueryClient();
  const { profile } = useSession();
  const key = ["providers", profile?.subject];
  return useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onMutate: async () => {
      await cache.cancelQueries({
        queryKey: ["provider-models", profile?.subject, provider],
      });
      cache.removeQueries({
        queryKey: ["provider-models", profile?.subject, provider],
      });
      await cache.cancelQueries({ queryKey: key });
      cache.setQueryData<ProviderConnection[]>(key, (items) =>
        items?.map((item) =>
          item.provider === provider && item.configured
            ? { ...item, status: "unverified" }
            : item,
        ),
      );
    },
    onSettled: async () => {
      await cache.invalidateQueries({ queryKey: key });
    },
  });
}
