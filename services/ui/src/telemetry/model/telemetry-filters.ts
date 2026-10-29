import {
  telemetryLimits,
  telemetryTimeRanges,
  type TelemetryOutcome,
  type TelemetryQuery,
  type TelemetrySeverity,
  type TelemetrySource,
  type TelemetryTimeRange,
  type TelemetryType,
} from "@everything/telemetry-contracts";

/** A preset range, or one the owner chooses. */
export type TelemetryRangeChoice = TelemetryTimeRange | "custom";

/**
 * How old spans must be before the list shows them: as soon as they are stored, a minute after
 * they started, or a number of minutes the owner chooses. Recording is never delayed.
 */
export const spanDelayChoices = [
  { id: "live", label: "Live", seconds: 0 },
  { id: "1m", label: "At least 1 minute old", seconds: 60 },
  { id: "custom", label: "Custom age", seconds: null },
] as const;
export type SpanDelayChoice = (typeof spanDelayChoices)[number]["id"];

/** Longest custom span age, in whole minutes. */
export const maxSpanDelayMinutes = telemetryLimits.maxSpanDelaySeconds / 60;

/** Everything the explorer filters by, as its controls hold it. */
export interface TelemetryFilters {
  /** Events are durable records such as failures; spans time each operation. */
  readonly view: TelemetrySource;
  readonly range: TelemetryRangeChoice;
  /** `datetime-local` values in the browser's time zone, used with a custom range. */
  readonly customFrom: string;
  readonly customTo: string;
  readonly type: TelemetryType | "all";
  readonly severity: TelemetrySeverity;
  readonly outcome: TelemetryOutcome | "any";
  /** A teammate's ID; empty for every teammate. */
  readonly agentId: string;
  /** A provider ID; empty for every provider. */
  readonly provider: string;
  readonly model: string;
  readonly correlationId: string;
  readonly search: string;
  /** Spans only: how old a span must be before the list shows it. */
  readonly delay: SpanDelayChoice;
  /** Whole minutes, as typed, for a custom span age. */
  readonly customDelay: string;
}

/** Errors first: failures from the last day. */
export const defaultTelemetryFilters: TelemetryFilters = {
  view: "events",
  range: "24h",
  customFrom: "",
  customTo: "",
  type: "all",
  severity: "error",
  outcome: "any",
  agentId: "",
  provider: "",
  model: "",
  correlationId: "",
  search: "",
  delay: "live",
  customDelay: "5",
};

/** Record types each view can show. */
export const typesByView: Readonly<
  Record<TelemetrySource, readonly TelemetryType[]>
> = {
  events: ["model", "turn", "http", "log"],
  spans: ["model", "turn", "http", "dependency", "tool"],
};

/** Characters a correlation ID consists of. */
const correlationPattern = new RegExp(
  `^[A-Za-z0-9_.:-]{1,${telemetryLimits.correlationLength}}$`,
);

/** Characters the API refuses in text filters. */
const unsafeText = /[\\\u0000-\u001F\u007F]/;

/** The API query for `filters` at `now`, or a message explaining which filter to fix. */
export function telemetryQuery(
  filters: TelemetryFilters,
  now: number,
): { readonly query: TelemetryQuery } | { readonly error: string } {
  const range = timeRange(filters, now);
  if ("error" in range) return range;
  const model = filters.model.trim();
  const search = filters.search.trim();
  const correlationId = filters.correlationId.trim();
  if (unsafeText.test(model) || unsafeText.test(search))
    return {
      error:
        "Search and model filters can’t include backslashes or control characters.",
    };
  if (correlationId && !correlationPattern.test(correlationId))
    return {
      error:
        "A correlation ID has only letters, numbers, and the characters . _ : -",
    };
  const minAge = filters.view === "spans" ? spanDelaySeconds(filters) : 0;
  if (minAge === undefined)
    return {
      error: `Choose a span age of 1 to ${maxSpanDelayMinutes} whole minutes.`,
    };
  return {
    query: {
      ...range,
      ...(minAge ? { minAge } : {}),
      severity: filters.severity,
      ...(filters.type !== "all" &&
      typesByView[filters.view].includes(filters.type)
        ? { type: filters.type }
        : {}),
      ...(filters.outcome !== "any" ? { outcome: filters.outcome } : {}),
      ...(filters.agentId ? { agentId: filters.agentId } : {}),
      ...(filters.provider ? { provider: filters.provider } : {}),
      ...(model ? { model: model.slice(0, telemetryLimits.modelLength) } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(search
        ? { search: search.slice(0, telemetryLimits.searchLength) }
        : {}),
    },
  };
}

/**
 * The minimum age, in seconds, a span list waits for, or undefined when the custom age isn't a
 * whole number of minutes from 1 to `maxSpanDelayMinutes`.
 */
export function spanDelaySeconds(
  filters: TelemetryFilters,
): number | undefined {
  const choice = spanDelayChoices.find(({ id }) => id === filters.delay);
  if (choice && choice.seconds !== null) return choice.seconds;
  const text = filters.customDelay.trim();
  if (!/^[0-9]{1,3}$/.test(text)) return undefined;
  const minutes = Number(text);
  return minutes >= 1 && minutes <= maxSpanDelayMinutes
    ? minutes * 60
    : undefined;
}

/** Whether filters beyond the view, time range, and severity narrow the results. */
export function hasNarrowingFilters(filters: TelemetryFilters): boolean {
  return (
    (filters.view === "spans" && filters.delay !== "live") ||
    filters.type !== "all" ||
    filters.outcome !== "any" ||
    !!filters.agentId ||
    !!filters.provider ||
    !!filters.model.trim() ||
    !!filters.correlationId.trim() ||
    !!filters.search.trim()
  );
}

/** The filters with only the view kept, for "Clear filters". */
export function clearedFilters(filters: TelemetryFilters): TelemetryFilters {
  return { ...defaultTelemetryFilters, view: filters.view };
}

/** The range's start and end as ISO times. */
function timeRange(
  filters: TelemetryFilters,
  now: number,
): { from: string; to: string } | { error: string } {
  if (filters.range !== "custom") {
    const minutes =
      telemetryTimeRanges.find(({ id }) => id === filters.range)?.minutes ??
      24 * 60;
    return {
      from: new Date(now - minutes * 60_000).toISOString(),
      to: new Date(now).toISOString(),
    };
  }
  const from = Date.parse(filters.customFrom);
  const to = filters.customTo ? Date.parse(filters.customTo) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to))
    return { error: "Choose a start and end time for the custom range." };
  if (from >= to) return { error: "Choose a start time before the end time." };
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
