import type { KeyboardEvent } from "react";
import type { TelemetryRecordSummary } from "@everything/telemetry-contracts";
import {
  formatDuration,
  formatTime,
  teammateName,
  typeLabel,
} from "../model/telemetry-presentation.js";
import { SeverityBadge } from "./severity-badge.js";

/**
 * Records newest first, one row each. Every row's summary is a button that opens its details in
 * the panel beside the list; Up and Down move between rows.
 */
export function TelemetryRecordTable({
  records,
  selectedId,
  teammates,
  showDuration,
  onSelect,
}: {
  records: readonly TelemetryRecordSummary[];
  selectedId: string | null;
  teammates:
    readonly { readonly id: string; readonly name: string }[] | undefined;
  showDuration: boolean;
  onSelect: (record: TelemetryRecordSummary) => void;
}) {
  /** Move focus to the previous or next row's button. */
  function moveFocus(event: KeyboardEvent<HTMLTableSectionElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ".telemetry-row-button",
      ),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const next = buttons[event.key === "ArrowDown" ? index + 1 : index - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  return (
    <table className="telemetry-table">
      <caption className="sr-only">
        Telemetry records, newest first. Choose a record to see its details.
      </caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Severity</th>
          <th scope="col">Summary</th>
          <th scope="col">Teammate</th>
          <th scope="col">Model</th>
          {showDuration && <th scope="col">Duration</th>}
        </tr>
      </thead>
      <tbody onKeyDown={moveFocus}>
        {records.map((record) => {
          const selected = record.id === selectedId;
          const cause = [record.category, record.code, record.httpStatus]
            .filter((value) => value !== null && value !== "")
            .join(" · ");
          return (
            <tr
              key={`${record.source}:${record.id}`}
              className={selected ? "selected" : ""}
            >
              <td className="telemetry-time">
                <time dateTime={record.time}>{formatTime(record.time)}</time>
              </td>
              <td>
                <SeverityBadge severity={record.severity} />
              </td>
              <td className="telemetry-summary">
                <button
                  type="button"
                  className="telemetry-row-button"
                  aria-pressed={selected}
                  aria-controls="telemetry-detail"
                  onClick={() => onSelect(record)}
                >
                  <span className="telemetry-title">{record.title}</span>
                  <small>
                    {typeLabel(record.type)}
                    {cause && ` · ${cause}`}
                  </small>
                </button>
              </td>
              <td className="telemetry-teammate">
                {teammateName(record.agentId, teammates) ?? "—"}
              </td>
              <td className="telemetry-model">{record.model ?? "—"}</td>
              {showDuration && <td>{formatDuration(record.durationMs)}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
