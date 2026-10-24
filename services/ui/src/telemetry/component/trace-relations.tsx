import type {
  TelemetryRecordSummary,
  TelemetryRelation,
  TelemetryTrace,
} from "@everything/telemetry-contracts";
import { telemetryRelations } from "@everything/telemetry-contracts";
import { formatTime } from "../model/telemetry-presentation.js";
import {
  relationLabels,
  relationLimits,
  relationNotes,
} from "../model/span-content.js";
import { SeverityBadge } from "./severity-badge.js";

/**
 * The trace's related traces, from the links recorded when work started and from run IDs: what
 * started it, what it started, and other traces of the same run. Each opens in place of this one,
 * as its own trace; nothing is merged into this trace's tree. What can't be shown, such as work
 * that isn't stored yet, is said rather than left out.
 */
export function TraceRelations({
  relations,
  onSelect,
}: {
  relations: TelemetryTrace["relations"];
  onSelect: (record: TelemetryRecordSummary) => void;
}) {
  if (relations === null)
    return (
      <section
        className="telemetry-relations"
        aria-labelledby="telemetry-relations-heading"
      >
        <h3 id="telemetry-relations-heading" className="telemetry-subheading">
          Related traces
        </h3>
        <p className="telemetry-muted">
          Related traces couldn’t be looked up this time. Refresh to try again.
        </p>
      </section>
    );
  const limits = relationLimits(relations);
  const groups = telemetryRelations
    .map((relation) => ({
      relation,
      related: relations.related.filter((item) => item.relation === relation),
    }))
    .filter((group) => group.related.length > 0);
  if (!groups.length && !limits.length) return null;
  return (
    <section
      className="telemetry-relations"
      aria-labelledby="telemetry-relations-heading"
    >
      <h3 id="telemetry-relations-heading" className="telemetry-subheading">
        Related traces
      </h3>
      {groups.map(({ relation, related }) => (
        <RelationGroup
          key={relation}
          relation={relation}
          spans={related.map((item) => item.span)}
          onSelect={onSelect}
        />
      ))}
      {limits.map((limit) => (
        <p key={limit} className="telemetry-muted">
          {limit}
        </p>
      ))}
    </section>
  );
}

/** One kind of relation, as a list of spans to open. */
function RelationGroup({
  relation,
  spans,
  onSelect,
}: {
  relation: TelemetryRelation;
  spans: readonly TelemetryRecordSummary[];
  onSelect: (record: TelemetryRecordSummary) => void;
}) {
  const heading = `telemetry-relation-${relation}`;
  return (
    <div className="telemetry-relation">
      <h4 id={heading}>{relationLabels[relation]}</h4>
      <p className="telemetry-muted">{relationNotes[relation]}</p>
      <ul className="telemetry-trace-events" aria-labelledby={heading}>
        {spans.map((span) => (
          <li key={`${span.traceId}:${span.id}`}>
            <button
              type="button"
              className="telemetry-link-button"
              onClick={() => onSelect(span)}
            >
              <SeverityBadge severity={span.severity} />
              <span>{span.title}</span>
              <time dateTime={span.time}>{formatTime(span.time)}</time>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
