import { createContext, useContext, type ReactNode } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  TelemetryQuery,
  TelemetryRecordSummary,
  TelemetrySource,
  TelemetryTrace,
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

/** How often an open trace that may still be completing is checked for records that arrived later. */
const traceWatchIntervalMs = 5_000;

/** How long after a record an open trace is watched for the rest of its work to arrive. */
const traceWatchWindowMs = 10 * 60_000;

/** One event's query key, for the signed-in owner only. */
function eventKey(subject: string | undefined, eventId: string | undefined) {
  return ["telemetry", "event", subject, eventId] as const;
}

/** One trace's query key, for the signed-in owner only. */
function traceKey(
  subject: string | undefined,
  traceId: string | null | undefined,
) {
  return ["telemetry", "trace", subject, traceId] as const;
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
 * pages never moves the range under the records already shown. Each refresh is a new
 * `generation`: it loads the newest page again, even for an unchanged fixed range, and older
 * pages load again on request. The records already shown stay until the refreshed ones arrive.
 */
export function useTelemetryRecords(
  view: TelemetrySource,
  query: TelemetryQuery | undefined,
  generation: number,
) {
  const client = useTelemetryClient();
  const { profile } = useSession();
  return useInfiniteQuery({
    queryKey: ["telemetry", view, profile?.subject, query, generation],
    queryFn: ({ pageParam, signal }) => {
      const page = { ...query, ...(pageParam ? { cursor: pageParam } : {}) };
      return view === "events"
        ? client.events(page, signal)
        : client.spans(page, signal);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!profile && !!query,
    // Changed filters show their own loading state; a refresh keeps the current records meanwhile.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === view &&
      previousQuery.queryKey[2] === profile?.subject &&
      previousQuery.queryKey[4] !== generation
        ? previous
        : undefined,
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
    queryKey: eventKey(profile?.subject, eventId),
    queryFn: ({ signal }) => client.event(eventId!, signal),
    enabled: !!profile && !!eventId,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/**
 * One trace's spans and events. Its records export in batches as its work finishes, so while
 * `watching` and the trace has no root span yet, it is checked again every few seconds, for at
 * most ten minutes after `recordTime`.
 */
export function useTelemetryTrace(
  traceId: string | null | undefined,
  recordTime: string,
  watching: boolean,
) {
  const client = useTelemetryClient();
  const { profile } = useSession();
  return useQuery({
    queryKey: traceKey(profile?.subject, traceId),
    queryFn: ({ signal }) => client.trace(traceId!, signal),
    enabled: !!profile && !!traceId,
    staleTime: 30_000,
    refetchInterval: (query) =>
      watching &&
      !complete(query.state.data) &&
      // Measured either way, so a server clock ahead of the browser's can't extend it.
      Math.abs(Date.now() - Date.parse(recordTime)) < traceWatchWindowMs
        ? traceWatchIntervalMs
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Whether a trace's root span, which ends after the work inside it, has arrived. */
function complete(trace: TelemetryTrace | undefined): boolean {
  return !!trace?.spans.some((span) => span.parentSpanId === null);
}

/**
 * Reload an open record's details and trace for the signed-in owner, keeping what is shown until
 * the new results arrive. Other owners' cached records are never touched.
 */
export function useRefreshTelemetryRecord(): (
  record: TelemetryRecordSummary | null,
) => void {
  const queryClient = useQueryClient();
  const { profile } = useSession();
  return (record) => {
    if (!record || !profile) return;
    if (record.source === "events")
      void queryClient.invalidateQueries({
        queryKey: eventKey(profile.subject, record.id),
        exact: true,
      });
    if (record.traceId)
      void queryClient.invalidateQueries({
        queryKey: traceKey(profile.subject, record.traceId),
        exact: true,
      });
  };
}
