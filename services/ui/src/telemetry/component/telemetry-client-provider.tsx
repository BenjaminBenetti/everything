import { createContext, useContext, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  TelemetryQuery,
  TelemetrySource,
} from "@everything/telemetry-contracts";
import { useSession } from "../../session/component/session-provider.js";
import type { TelemetryClient } from "../interface/telemetry-client.js";

const TelemetryClientContext = createContext<TelemetryClient | null>(null);

/** Inject telemetry access so the explorer stays independent of its HTTP implementation. */
export function TelemetryClientProvider({
  client,
  children,
}: {
  client: TelemetryClient;
  children: ReactNode;
}) {
  return (
    <TelemetryClientContext.Provider value={client}>
      {children}
    </TelemetryClientContext.Provider>
  );
}

/** Resolve the telemetry client at the composition boundary. */
export function useTelemetryClient(): TelemetryClient {
  const client = useContext(TelemetryClientContext);
  if (!client) throw new Error("TelemetryClientProvider is required");
  return client;
}

/** Whether telemetry is on and answering, rechecked while the explorer is open. */
export function useTelemetryStatus() {
  const client = useTelemetryClient();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["telemetry", "status", profile?.subject],
    queryFn: ({ signal }) => client.status(signal),
    enabled: !!profile,
    refetchInterval: 30_000,
    retry: false,
  });
}

/**
 * Pages of events or spans for a query fixed when the filters were applied, so loading older
 * pages or refetching never moves the range under the records already shown.
 */
export function useTelemetryRecords(
  view: TelemetrySource,
  query: TelemetryQuery | undefined,
) {
  const client = useTelemetryClient();
  const { profile } = useSession();
  return useInfiniteQuery({
    queryKey: ["telemetry", view, profile?.subject, query],
    queryFn: ({ pageParam, signal }) => {
      const page = { ...query, ...(pageParam ? { cursor: pageParam } : {}) };
      return view === "events"
        ? client.events(page, signal)
        : client.spans(page, signal);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!profile && !!query,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/**
 * Records newer than `since` that match the applied filters, checked every fifteen seconds while
 * watching is on. They are only counted for the explorer to offer; nothing already shown moves.
 */
export function useNewerRecords(
  view: TelemetrySource,
  query: TelemetryQuery | undefined,
  since: string | undefined,
  enabled: boolean,
) {
  const client = useTelemetryClient();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["telemetry", "newer", view, profile?.subject, query, since],
    queryFn: ({ signal }) => {
      const { to: _to, cursor: _cursor, ...filters } = query!;
      const newer = { ...filters, from: since!, limit: 100 };
      return view === "events"
        ? client.events(newer, signal)
        : client.spans(newer, signal);
    },
    enabled: enabled && !!profile && !!query && !!since,
    // Nothing is newer than what just loaded, so the first check waits for the interval.
    initialData: {
      records: [],
      nextCursor: null,
      from: since ?? "",
      to: since ?? "",
    },
    initialDataUpdatedAt: () => Date.now(),
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** One event's diagnosis. */
export function useTelemetryEvent(eventId: string | undefined) {
  const client = useTelemetryClient();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["telemetry", "event", profile?.subject, eventId],
    queryFn: ({ signal }) => client.event(eventId!, signal),
    enabled: !!profile && !!eventId,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** One trace's spans and events. */
export function useTelemetryTrace(traceId: string | null | undefined) {
  const client = useTelemetryClient();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["telemetry", "trace", profile?.subject, traceId],
    queryFn: ({ signal }) => client.trace(traceId!, signal),
    enabled: !!profile && !!traceId,
    staleTime: 30_000,
    retry: false,
  });
}
