import {
  telemetryLimits,
  type TelemetryPreview,
  type TelemetryPreviewKind,
  type TelemetryRelation,
  type TelemetryTraceRelations,
} from "@everything/telemetry-contracts";

/** What each kind of preview shows, as its heading. */
export const previewLabels: Readonly<Record<TelemetryPreviewKind, string>> = {
  message: "Message sent to your teammate",
  tool_arguments: "Tool call arguments",
  sql: "SQL statement",
};

/** Previews longer than this many lines start collapsed, with a way to show all of them. */
export const collapsedPreviewLines = 8;

/** The note under a preview: what it leaves out, and what was removed before it was stored. */
export function previewNote(preview: TelemetryPreview): string {
  const redaction =
    "Recognizable credentials were removed before it was stored.";
  switch (preview.kind) {
    case "message":
      return preview.truncated
        ? `Shows the start and end of ${preview.originalLength === null ? "a long message" : `a ${preview.originalLength.toLocaleString()}-character message`}; the middle isn’t shown. ${redaction}`
        : redaction;
    case "tool_arguments":
      return preview.truncated
        ? `Long values were shortened and some were summarized, so this isn’t everything the tool received. ${redaction}`
        : redaction;
    case "sql":
      return `Parameters appear as $1, $2, … and values written into the statement as ?; neither is recorded.${preview.truncated ? " The statement was cut to fit, so its end isn’t shown." : ""}`;
  }
}

/**
 * A preview as it reads best: JSON indented, anything else as stored. Previews are bounded by the
 * server to `telemetryLimits.previewBytes`, so formatting them is cheap.
 */
export function formatPreview(preview: TelemetryPreview): string {
  if (
    preview.format !== "json" ||
    preview.value.length > telemetryLimits.previewBytes * 2
  )
    return preview.value;
  try {
    return JSON.stringify(JSON.parse(preview.value), null, 2);
  } catch {
    return preview.value;
  }
}

/** Whether a formatted preview is long enough to start collapsed. */
export function isLongPreview(text: string): boolean {
  return text.split("\n").length > collapsedPreviewLines || text.length > 600;
}

/** Each relation's heading, in the order the trace's relations list them. */
export const relationLabels: Readonly<Record<TelemetryRelation, string>> = {
  started_by: "Started by",
  started: "Started",
  same_run: "Same run",
};

/** What a relation means, for the note beside its list. */
export const relationNotes: Readonly<Record<TelemetryRelation, string>> = {
  started_by: "The work in another trace that started this one.",
  started:
    "Work this trace started, which runs in a trace of its own. It appears once its first span is stored.",
  same_run:
    "Traces recorded under the same run ID, such as a request and the teammate turn it started. A turn that is still running shows the first span stored so far.",
};

/** Notes about what a trace's relations can't show, in the order they apply. */
export function relationLimits(
  relations: TelemetryTraceRelations,
): readonly string[] {
  return [
    ...(relations.unresolved
      ? [
          "This trace links to work that isn’t available: it may not be stored yet, or it has expired.",
        ]
      : []),
    ...(relations.truncated
      ? ["Only the first related traces are listed."]
      : []),
  ];
}
