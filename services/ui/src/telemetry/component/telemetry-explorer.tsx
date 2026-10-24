import { useEffect, useRef, useState } from "react";
import { Activity, SearchX } from "lucide-react";
import type {
  TelemetryQuery,
  TelemetryRecordSummary,
  TelemetrySource,
  TelemetryStatus,
} from "@everything/telemetry-contracts";
import { Button } from "@everything/ui/button";
import { useAgents } from "../../agent/component/agent-directory-provider.js";
import { EmptyState } from "../../workspace/component/empty-state.js";
import { PageHeading } from "../../workspace/component/page-heading.js";
import {
  clearedFilters,
  defaultTelemetryFilters,
  hasNarrowingFilters,
  telemetryQuery,
  typesByView,
  type TelemetryFilters,
} from "../model/telemetry-filters.js";
import { formatTime } from "../model/telemetry-presentation.js";
import { useKeepInPlace } from "../hook/use-keep-in-place.js";
import {
  useNewerRecords,
  useRefreshTelemetryRecord,
  useTelemetryRecords,
  useTelemetryStatus,
} from "./telemetry-client-provider.js";
import { TelemetryDetailPanel } from "./telemetry-detail-panel.js";
import { TelemetryFilterBar } from "./telemetry-filter-bar.js";
import { TelemetryRecordTable } from "./telemetry-record-table.js";

/**
 * Filters applied to the list, fixed when applied so loading more never shifts the range. Each
 * refresh is a new generation, so it reloads even a fixed range whose query is unchanged.
 */
interface AppliedFilters {
  readonly view: TelemetrySource;
  readonly query?: TelemetryQuery;
  readonly error?: string;
  readonly generation: number;
}

/** Text filters wait for typing to pause before they apply. */
const typingDelayMs = 400;

/** The filters as the list applies them now, in `generation`. */
function apply(filters: TelemetryFilters, generation = 0): AppliedFilters {
  const result = telemetryQuery(filters, Date.now());
  return "query" in result
    ? { view: filters.view, query: result.query, generation }
    : { view: filters.view, error: result.error, generation };
}

/**
 * Search the owner's telemetry, errors first: filters above a list of records, and the selected
 * record's diagnosis and trace beside it. New records are announced rather than inserted, so the
 * list never moves while someone reads it, and the open record stays open.
 */
export function TelemetryExplorer() {
  const status = useTelemetryStatus();
  const agents = useAgents();
  const [filters, setFilters] = useState(defaultTelemetryFilters);
  const [applied, setApplied] = useState(() => apply(defaultTelemetryFilters));
  const [selected, setSelected] = useState<TelemetryRecordSummary | null>(null);
  const [live, setLive] = useState(true);
  const typing = useRef<number | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  const keepInPlace = useKeepInPlace(selected);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const refreshRecord = useRefreshTelemetryRecord();
  const available = status.data?.state === "available";
  const records = useTelemetryRecords(
    applied.view,
    applied.query,
    applied.generation,
  );
  const list = records.data?.pages.flatMap((page) => page.records) ?? [];
  const shown = new Set(list.map((record) => record.id));
  const newer = useNewerRecords(
    applied.view,
    applied.query,
    list[0]?.time ?? applied.query?.to,
    live && available && filters.range !== "custom",
  );
  const newCount =
    newer.data?.records.filter((record) => !shown.has(record.id)).length ?? 0;
  useEffect(() => () => window.clearTimeout(typing.current), []);

  /** Update the controls, applying text after a pause and everything else at once. */
  function change(patch: Partial<TelemetryFilters>): void {
    let next = { ...filters, ...patch };
    if (next.type !== "all" && !typesByView[next.view].includes(next.type))
      next = { ...next, type: "all" };
    setFilters(next);
    window.clearTimeout(typing.current);
    const typed = [
      "model",
      "search",
      "correlationId",
      "customFrom",
      "customTo",
    ].some((key) => key in patch);
    if (typed)
      typing.current = window.setTimeout(
        () => setApplied((current) => apply(next, current.generation)),
        typingDelayMs,
      );
    else setApplied(apply(next, applied.generation));
  }

  /**
   * Reload the list from its newest page, with a rolling range brought up to now, and the open
   * record's details and trace, which stay open. Even a fixed range is fetched again, since records
   * from its period can arrive after it was first loaded.
   */
  function refresh(): void {
    window.clearTimeout(typing.current);
    setApplied((current) => apply(filters, current.generation + 1));
    refreshRecord(selected);
  }

  /** Show the newer records, moving focus from the announcement, which goes away, to the list. */
  function showNewer(): void {
    refresh();
    resultsHeading.current?.focus();
  }

  /**
   * Open a record's details, remembering the row to return focus to. A row in the list opens
   * details and stays where it is on screen while the list makes room for them; a record chosen
   * inside the details keeps that row.
   */
  function select(record: TelemetryRecordSummary, row?: HTMLElement): void {
    if (row) {
      opener.current = row;
      keepInPlace(row);
    }
    setSelected(record);
  }

  /** Close the details and return focus to the row that opened them, where it is on screen. */
  function close(): void {
    keepInPlace(opener.current?.isConnected ? opener.current : null);
    setSelected(null);
    if (opener.current?.isConnected)
      opener.current.focus({ preventScroll: true });
    opener.current = null;
  }

  if (status.isPending)
    return (
      <div className="telemetry-page">
        <Heading status={undefined} />
        <p className="status-panel" role="status">
          Checking telemetry…
        </p>
      </div>
    );
  if (status.isError)
    return (
      <div className="telemetry-page">
        <Heading status={undefined} />
        <div className="status-panel" role="alert">
          <p>Telemetry’s status couldn’t be checked. {status.error.message}</p>
          <Button variant="light" onClick={() => void status.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  if (status.data.state === "disabled")
    return (
      <div className="telemetry-page">
        <Heading status={status.data} />
        <EmptyState icon={Activity} title="Telemetry is turned off">
          <p>
            This installation runs without telemetry storage, so errors and
            traces aren’t recorded. Whoever manages the installation can turn it
            on; the deployment guide explains how.
          </p>
        </EmptyState>
      </div>
    );

  const narrowed = hasNarrowingFilters(filters);
  return (
    <div className="telemetry-page">
      <Heading status={status.data} />
      <ExportNotice status={status.data} />
      <TelemetryFilterBar
        filters={filters}
        teammates={agents.data ?? []}
        live={live}
        error={applied.error ?? null}
        refreshing={records.isPlaceholderData}
        onChange={change}
        onRefresh={refresh}
        onClear={() => change(clearedFilters(filters))}
        onLiveChange={setLive}
      />
      <div className={`telemetry-layout${selected ? " with-detail" : ""}`}>
        <section
          className="telemetry-results"
          aria-labelledby="telemetry-results-heading"
          aria-busy={records.isPlaceholderData}
        >
          <div className="list-tools">
            <h2
              className="section-label"
              id="telemetry-results-heading"
              ref={resultsHeading}
              tabIndex={-1}
            >
              {applied.view === "events" ? "Events" : "Spans"}{" "}
              <span>
                {records.isSuccess
                  ? `${list.length}${records.hasNextPage ? "+" : ""}`
                  : "—"}
              </span>
            </h2>
            {records.data?.pages[0] && (
              <p className="telemetry-range">
                {formatTime(records.data.pages[0].from)} –{" "}
                {formatTime(records.data.pages[0].to)}
              </p>
            )}
          </div>
          {newCount > 0 && (
            <div className="telemetry-new" role="status">
              <span>
                {newCount === 1
                  ? "1 newer record"
                  : `${newCount}${newCount >= 100 ? "+" : ""} newer records`}{" "}
                match these filters.
              </span>
              <Button variant="light" onClick={showNewer}>
                Show newer records
              </Button>
            </div>
          )}
          {applied.error ? null : records.isPending ? (
            <p className="status-panel" role="status">
              Loading telemetry…
            </p>
          ) : records.isError ? (
            <div className="status-panel" role="alert">
              <p>Telemetry couldn’t be loaded. {records.error.message}</p>
              <Button variant="light" onClick={() => void records.refetch()}>
                Try again
              </Button>
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title={
                !narrowed && filters.severity === "error"
                  ? "No errors in this time range"
                  : "Nothing matches these filters"
              }
            >
              <p>
                {!narrowed && filters.severity === "error"
                  ? "Failures would appear here. Try a longer time range, or include warnings and other records."
                  : "Try a longer time range or fewer filters."}
              </p>
              {!narrowed && filters.severity === "error" ? (
                <Button
                  variant="light"
                  onClick={() => change({ severity: "info" })}
                >
                  Show all severities
                </Button>
              ) : (
                <Button
                  variant="light"
                  onClick={() => change(clearedFilters(filters))}
                >
                  Clear filters
                </Button>
              )}
            </EmptyState>
          ) : (
            <>
              <TelemetryRecordTable
                records={list}
                selectedId={selected?.id ?? null}
                teammates={agents.data}
                showDuration={applied.view === "spans"}
                onSelect={select}
              />
              {records.hasNextPage && (
                <Button
                  variant="light"
                  className="telemetry-more"
                  disabled={records.isFetchingNextPage}
                  onClick={() => void records.fetchNextPage()}
                >
                  {records.isFetchingNextPage
                    ? "Loading older records…"
                    : "Load older records"}
                </Button>
              )}
            </>
          )}
        </section>
        {selected && (
          <TelemetryDetailPanel
            key={`${selected.source}:${selected.id}`}
            record={selected}
            teammates={agents.data}
            watching={live}
            onSelect={select}
            onClose={close}
          />
        )}
      </div>
    </div>
  );
}

/** The page title, with the retention period once it is known. */
function Heading({ status }: { status: TelemetryStatus | undefined }) {
  return (
    <PageHeading
      title="Telemetry"
      description={`Find out why something didn’t work: model and provider errors, requests, and teammate work${
        status ? `, kept for ${status.retentionDays} days` : ""
      }.`}
    />
  );
}

/** Storage that isn't answering, or exports that are failing or dropping records. */
function ExportNotice({ status }: { status: TelemetryStatus }) {
  const health = status.export;
  const failing =
    !!health?.lastFailureAt &&
    (!health.lastSuccessAt || health.lastFailureAt > health.lastSuccessAt);
  if (status.state === "unavailable")
    return (
      <div className="telemetry-notice" role="alert">
        Telemetry storage isn’t responding right now. Everything keeps working;
        new records wait in a small queue, and some may be lost if storage stays
        unreachable.
      </div>
    );
  if (!failing && !health?.droppedRecords) return null;
  return (
    <div className="telemetry-notice" role="status">
      {failing &&
        "Recent records couldn’t be saved yet; Everything keeps retrying. "}
      {!!health?.droppedRecords &&
        `${health.droppedRecords} records were dropped because storage didn’t keep up.`}
    </div>
  );
}
