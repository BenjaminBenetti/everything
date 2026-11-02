import { useEffect, useState, useSyncExternalStore } from "react";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import type { Agent } from "@everything/agent-contracts";
import {
  useAgentDirectory,
  useModelContextCache,
} from "../component/agent-directory-provider.js";
import { useSession } from "../../session/component/session-provider.js";
import { useProviders } from "../../provider/component/provider-connections-context.js";
import { contextQueryOptions } from "../model/context-query.js";

/** Hydrate the quiet row immediately; only stale or genuinely changed identities need discovery. */
export function useContextBudget(agent: Agent): number | undefined {
  const directory = useAgentDirectory();
  const cache = useModelContextCache();
  const { profile } = useSession();
  const providers = useProviders();
  useSyncExternalStore(cache.subscribe, cache.snapshot, cache.snapshot);
  const connection = providers.data?.find(
    (item) => item.provider === agent.inference?.provider,
  );
  // Check time/status/messages are cosmetic. Addresses/accounts are transient input to a digest only.
  const signature = JSON.stringify(
    connection
      ? [
          connection.provider,
          connection.configured,
          connection.baseUrl,
          connection.model,
          connection.account,
        ]
      : null,
  );
  const [observed, setObserved] = useState<string>();
  const changing =
    useIsMutating({
      mutationKey: [
        "provider-change",
        profile?.subject,
        agent.inference?.provider,
      ],
    }) > 0;
  if (profile && !agent.inference) cache.discard(profile.subject, agent.id);
  const scope =
    profile && agent.inference
      ? cache.scope(profile.subject, agent.id, agent.inference)
      : undefined;
  useEffect(() => {
    let current = true;
    if (changing) return;
    void (async () => {
      if (profile && agent.inference && providers.isSuccess)
        await cache.observeConnection(
          profile.subject,
          agent.inference.provider,
          connection,
        );
      if (current) setObserved(signature);
    })().catch(() => {
      if (current) setObserved(signature);
    });
    return () => {
      current = false;
    };
  }, [
    cache,
    profile?.subject,
    agent.inference?.provider,
    providers.isSuccess,
    signature,
    changing,
  ]);
  const options =
    scope && agent.inference
      ? contextQueryOptions(directory, cache, scope, agent.inference)
      : undefined;
  const query = useQuery<number, Error, number, string[]>({
    ...(options ?? {
      queryKey: ["agent-context", "inactive", agent.id],
      queryFn: async () => {
        throw new Error("No model selected");
      },
    }),
    enabled:
      !!options &&
      !changing &&
      (providers.isSuccess ? observed === signature : providers.isError),
  });
  return query.data;
}
