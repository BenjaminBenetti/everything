import { useId, useState } from "react";
import type { TelemetryPreview } from "@everything/telemetry-contracts";
import { Button } from "@everything/ui/button";
import {
  formatPreview,
  isLongPreview,
  previewLabels,
  previewNote,
} from "../model/span-content.js";

/**
 * What a span worked on, as the server stored it: the message a turn answered, a tool call's
 * arguments, or an SQL statement, each labelled with what it leaves out. Long previews start
 * collapsed. When the installation withheld content, it says so instead of showing nothing.
 */
export function SpanPreviews({
  previews = [],
  contentWithheld = false,
}: {
  /** Undefined, like `contentWithheld`, from an API that predates previews. */
  previews?: readonly TelemetryPreview[] | undefined;
  contentWithheld?: boolean | undefined;
}) {
  if (!previews.length && !contentWithheld) return null;
  return (
    <div className="telemetry-previews">
      {previews.map((preview) => (
        <PreviewBlock key={preview.kind} preview={preview} />
      ))}
      {contentWithheld && (
        <section className="telemetry-preview">
          <h4>Content withheld</h4>
          <p className="telemetry-muted">
            The installation wasn’t recording content previews when this
            happened, so the message, tool arguments, or SQL statement wasn’t
            stored. Whoever manages the installation can turn them on for later
            records; the deployment guide explains how.
          </p>
        </section>
      )}
    </div>
  );
}

/** One preview with its heading and note, collapsed at first when it is long. */
function PreviewBlock({ preview }: { preview: TelemetryPreview }) {
  const id = useId();
  const text = formatPreview(preview);
  const long = isLongPreview(text);
  const [expanded, setExpanded] = useState(!long);
  return (
    <section className="telemetry-preview" aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`}>
        {previewLabels[preview.kind]}
        {preview.truncated && (
          <span className="telemetry-preview-badge">Shortened</span>
        )}
      </h4>
      <p className="telemetry-muted">{previewNote(preview)}</p>
      <pre
        id={`${id}-value`}
        className={`telemetry-preview-value${expanded ? "" : " collapsed"}`}
        tabIndex={0}
        aria-label={previewLabels[preview.kind]}
      >
        {text}
      </pre>
      {long && (
        <Button
          variant="text"
          type="button"
          aria-expanded={expanded}
          aria-controls={`${id}-value`}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show all"}
        </Button>
      )}
    </section>
  );
}
