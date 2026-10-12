import { ExternalLink } from "lucide-react";
import type { ArtifactSummary } from "@everything/artifact-contracts";
import {
  isViewable,
  kindLabels,
  relativeTime,
  statusLabels,
} from "../model/artifact-presentation.js";

/** An artifact with who changed it last; opening it signs the browser in to the artifact host. */
export function ArtifactCard({ artifact }: { artifact: ArtifactSummary }) {
  const openPath = `/artifacts/open?slug=${encodeURIComponent(artifact.slug)}`;
  return (
    <article className="artifact-card">
      <p className="artifact-kind">{kindLabels[artifact.kind]}</p>
      <h2>{artifact.title}</h2>
      <p className="artifact-description">
        {artifact.description || `/${artifact.slug}`}
      </p>
      <p className="artifact-byline">
        Updated by {artifact.updatedBy.name} {relativeTime(artifact.updatedAt)}
      </p>
      <div className="card-bottom">
        <span
          className={`artifact-status status-${artifact.status}`}
          aria-hidden="true"
        />
        {statusLabels[artifact.status]}
        {isViewable(artifact.status) && (
          <a
            className="artifact-open"
            href={openPath}
            target="_blank"
            rel="noopener"
            aria-label={`Open ${artifact.title} in a new tab`}
          >
            Open
            <ExternalLink aria-hidden="true" />
          </a>
        )}
      </div>
    </article>
  );
}
