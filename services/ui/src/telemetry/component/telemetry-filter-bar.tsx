import { useId } from "react";
import { RefreshCw } from "lucide-react";
import { providerIds } from "@everything/provider-contracts";
import {
  telemetryOutcomes,
  telemetryTimeRanges,
  type TelemetryOutcome,
  type TelemetrySeverity,
  type TelemetrySource,
  type TelemetryType,
} from "@everything/telemetry-contracts";
import { Button } from "@everything/ui/button";
import { InputSurface } from "@everything/ui/input-surface";
import { SearchInput } from "@everything/ui/search-input";
import { Select } from "@everything/ui/select";
import { Switch } from "@everything/ui/switch";
import { providerOptions } from "../../provider/model/provider-options.js";
import {
  maxSpanDelayMinutes,
  spanDelayChoices,
  spanDelaySeconds,
  typesByView,
  type SpanDelayChoice,
  type TelemetryFilters,
  type TelemetryRangeChoice,
} from "../model/telemetry-filters.js";
import { outcomeLabels, typeLabel } from "../model/telemetry-presentation.js";

/** The explorer's views, as segmented choices. */
const views: readonly {
  value: TelemetrySource;
  label: string;
  description: string;
}[] = [
  {
    value: "events",
    label: "Events",
    description: "Failures, warnings, and stops",
  },
  {
    value: "spans",
    label: "Spans",
    description: "Requests, dependency calls, and teammate work",
  },
];

/** Severity choices, each including the more severe levels. */
const severityOptions: readonly { value: TelemetrySeverity; label: string }[] =
  [
    { value: "error", label: "Errors" },
    { value: "warning", label: "Warnings and errors" },
    { value: "info", label: "All severities" },
  ];

/**
 * Every filter the explorer offers, as labelled native and shared controls: the view, time range,
 * severity, type, outcome, how old spans must be, teammate, provider, model, a correlation ID, and
 * free text.
 */
export function TelemetryFilterBar({
  filters,
  teammates,
  live,
  error,
  refreshing,
  onChange,
  onRefresh,
  onClear,
  onLiveChange,
}: {
  filters: TelemetryFilters;
  teammates: readonly { readonly id: string; readonly name: string }[];
  live: boolean;
  error: string | null;
  /** A refresh is loading while the current records stay shown. */
  refreshing: boolean;
  onChange: (next: Partial<TelemetryFilters>) => void;
  onRefresh: () => void;
  onClear: () => void;
  onLiveChange: (live: boolean) => void;
}) {
  const id = useId();
  return (
    <form
      className="telemetry-filters"
      role="search"
      aria-label="Filter telemetry"
      onSubmit={(event) => {
        event.preventDefault();
        onRefresh();
      }}
    >
      <div className="telemetry-filter-row">
        <fieldset className="telemetry-views">
          <legend className="sr-only">Show</legend>
          {views.map((view) => (
            <label
              key={view.value}
              className="telemetry-view"
              title={view.description}
            >
              <input
                type="radio"
                name={`${id}-view`}
                value={view.value}
                checked={filters.view === view.value}
                onChange={() => onChange({ view: view.value })}
              />
              <span>{view.label}</span>
            </label>
          ))}
        </fieldset>
        <Select
          label="Time range"
          value={filters.range}
          placeholder="Last day"
          options={[
            ...telemetryTimeRanges.map(({ id, label }) => ({
              value: id,
              label,
            })),
            { value: "custom", label: "Custom range" },
          ]}
          onValueChange={(range) =>
            onChange({ range: range as TelemetryRangeChoice })
          }
        />
        <Select
          label="Severity"
          value={filters.severity}
          placeholder="Errors"
          options={severityOptions}
          onValueChange={(severity) =>
            onChange({ severity: severity as TelemetrySeverity })
          }
        />
        <Select
          label="Type"
          value={filters.type}
          placeholder="All types"
          options={[
            { value: "all", label: "All types" },
            ...typesByView[filters.view].map((type) => ({
              value: type,
              label: typeLabel(type),
            })),
          ]}
          onValueChange={(type) =>
            onChange({ type: type as TelemetryType | "all" })
          }
        />
        <Select
          label="Outcome"
          value={filters.outcome}
          placeholder="Any outcome"
          options={[
            { value: "any", label: "Any outcome" },
            ...telemetryOutcomes.map((outcome) => ({
              value: outcome,
              label: outcomeLabels[outcome],
            })),
          ]}
          onValueChange={(outcome) =>
            onChange({ outcome: outcome as TelemetryOutcome | "any" })
          }
        />
        {filters.view === "spans" && (
          <Select
            label="Span age"
            value={filters.delay}
            placeholder="Live"
            options={spanDelayChoices.map(({ id, label }) => ({
              value: id,
              label,
            }))}
            onValueChange={(delay) =>
              onChange({ delay: delay as SpanDelayChoice })
            }
          />
        )}
      </div>
      {filters.view === "spans" && filters.delay !== "live" && (
        <div className="telemetry-filter-row">
          {filters.delay === "custom" && (
            <label className="telemetry-field">
              <span>Minutes old</span>
              <InputSurface>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={maxSpanDelayMinutes}
                  step={1}
                  value={filters.customDelay}
                  onChange={(event) =>
                    onChange({ customDelay: event.target.value })
                  }
                />
              </InputSurface>
            </label>
          )}
          <p className="telemetry-muted">{spanAgeHint(filters)}</p>
        </div>
      )}
      {filters.range === "custom" && (
        <div className="telemetry-filter-row">
          <label className="telemetry-field">
            <span>From</span>
            <InputSurface>
              <input
                type="datetime-local"
                value={filters.customFrom}
                onChange={(event) =>
                  onChange({ customFrom: event.target.value })
                }
              />
            </InputSurface>
          </label>
          <label className="telemetry-field">
            <span>To</span>
            <InputSurface>
              <input
                type="datetime-local"
                value={filters.customTo}
                onChange={(event) => onChange({ customTo: event.target.value })}
              />
            </InputSurface>
          </label>
        </div>
      )}
      <div className="telemetry-filter-row">
        <Select
          label="Teammate"
          value={filters.agentId}
          placeholder="All teammates"
          options={[
            { value: "", label: "All teammates" },
            ...teammates.map(({ id, name }) => ({ value: id, label: name })),
          ]}
          onValueChange={(agentId) => onChange({ agentId })}
        />
        <Select
          label="Provider"
          value={filters.provider}
          placeholder="All providers"
          options={[
            { value: "", label: "All providers" },
            ...providerIds.map((provider) => ({
              value: provider,
              label: providerOptions[provider].title,
            })),
          ]}
          onValueChange={(provider) => onChange({ provider })}
        />
        <InputSurface as="label" className="telemetry-text-filter">
          <span className="sr-only">Model</span>
          <input
            value={filters.model}
            placeholder="Model"
            maxLength={200}
            onChange={(event) => onChange({ model: event.target.value })}
          />
        </InputSurface>
        <InputSurface as="label" className="telemetry-text-filter">
          <span className="sr-only">Trace, run, session, or request ID</span>
          <input
            value={filters.correlationId}
            placeholder="Trace, run, or request ID"
            maxLength={128}
            spellCheck={false}
            onChange={(event) =>
              onChange({ correlationId: event.target.value })
            }
          />
        </InputSurface>
      </div>
      <div className="telemetry-filter-row">
        <SearchInput
          label="Search telemetry"
          className="telemetry-search"
          placeholder="Search summaries, codes, and messages…"
          value={filters.search}
          maxLength={200}
          onChange={(event) => onChange({ search: event.target.value })}
        />
        <Switch
          label="Watch for new records"
          checked={live}
          onChange={onLiveChange}
          className="telemetry-live"
        />
        <Button variant="light" type="submit" aria-busy={refreshing}>
          <RefreshCw
            aria-hidden="true"
            className={refreshing ? "telemetry-refreshing" : undefined}
          />
          Refresh
        </Button>
        <Button variant="text" type="button" onClick={onClear}>
          Clear filters
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** What a span age shows, in plain words, so a delayed list isn't mistaken for a complete one. */
function spanAgeHint(filters: TelemetryFilters): string {
  const seconds = spanDelaySeconds(filters);
  if (seconds === undefined)
    return `Enter 1 to ${maxSpanDelayMinutes} whole minutes.`;
  const minutes = seconds / 60;
  return `Showing spans that started at least ${minutes === 1 ? "1 minute" : `${minutes} minutes`} ago, by the server’s clock. Recording isn’t delayed, and an older span’s trace can still be filling in.`;
}
