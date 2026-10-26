import { useId, useState } from "react";
import { LoaderCircle, Pause, Play, Trash2 } from "lucide-react";
import { IconButton } from "@everything/ui/button";
import { ConfirmationDialog } from "@everything/ui/confirmation-dialog";
import type { ArtifactSummary } from "@everything/artifact-contracts";
import { useAppAction, type AppAction } from "../hook/use-app-action.js";
import {
  isViewable,
  relativeTime,
  statusLabels,
} from "../model/artifact-presentation.js";
import type { AppCreator } from "../model/artifact-filters.js";
import { ArtifactMetadata } from "./artifact-metadata.js";
import { ArtifactSharing } from "./artifact-sharing.js";

const pendingLabels: Record<AppAction, string> = {
  start: "Starting…",
  stop: "Stopping…",
  delete: "Deleting…",
};

/** Open a live app from its whole card, with separate guarded lifecycle controls. */
export function ArtifactCard({
  artifact,
  creator,
  unavailable,
}: {
  artifact: ArtifactSummary;
  creator: AppCreator;
  unavailable: boolean;
}) {
  const heading = useId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mutation = useAppAction(artifact, () => setConfirmDelete(false));
  const active = ["live", "running", "starting", "failing"].includes(
    artifact.status,
  );
  const action = active ? "stop" : "start";
  const actionLabel = active ? "Stop" : "Start";
  const canControl = !unavailable && !mutation.isPending;
  const canDelete =
    artifact.status === "stopped" || artifact.status === "unpublished";
  const canOpen = !mutation.isPending && isViewable(artifact.status);
  const statusLabel = mutation.isPending
    ? pendingLabels[mutation.variables]
    : statusLabels[artifact.status];
  const openPath = `/apps/open?slug=${encodeURIComponent(artifact.slug)}`;
  return (
    <article
      className="artifact-card"
      aria-labelledby={heading}
      aria-busy={mutation.isPending}
    >
      {canOpen && (
        <a
          className="artifact-card-link"
          href={openPath}
          target="_blank"
          rel="noopener"
          aria-label={`Open ${artifact.title} in a new tab`}
        />
      )}
      <ArtifactMetadata artifact={artifact} creator={creator} />
      <h2 id={heading}>{artifact.title}</h2>
      <p className="artifact-description">
        {artifact.description || `/${artifact.slug}`}
      </p>
      <p className="artifact-byline">
        Updated by {artifact.updatedBy.name} {relativeTime(artifact.updatedAt)}
      </p>
      <div className="artifact-card-footer">
        <span className="artifact-state">
          <span
            className={`artifact-status status-${artifact.status}`}
            aria-hidden="true"
          />
          {statusLabel}
        </span>
        <div className="artifact-controls">
          <ArtifactSharing artifact={artifact} unavailable={unavailable} />
          <IconButton
            label={`${mutation.isPending ? statusLabel : actionLabel} ${artifact.title}`}
            disabled={!canControl || artifact.status === "unpublished"}
            onClick={() => mutation.mutate(action)}
          >
            {mutation.isPending ? (
              <LoaderCircle
                className="artifact-action-spinner"
                aria-hidden="true"
              />
            ) : active ? (
              <Pause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
          </IconButton>
          {canDelete && (
            <IconButton
              label={`Delete ${artifact.title}`}
              className="artifact-delete"
              disabled={!canControl}
              onClick={(event) => {
                event.currentTarget.setAttribute("data-dialog-return", "");
                mutation.reset();
                setConfirmDelete(true);
              }}
            >
              <Trash2 aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </div>
      {mutation.isError && !confirmDelete && (
        <p className="form-error" role="alert">
          The app action couldn’t finish. Refresh its status and try again.
        </p>
      )}
      {confirmDelete && (
        <ConfirmationDialog
          title="Delete app?"
          description={`“${artifact.title}” and its files, history, database, and saved data will be permanently deleted. This can’t be undone.`}
          confirmLabel="Delete app"
          pendingLabel="Deleting…"
          pending={mutation.isPending}
          {...(mutation.isError
            ? {
                error:
                  "The app couldn’t be deleted. It may no longer be stopped. Close this dialog, check its status, and try again.",
              }
            : {})}
          onCancel={() => {
            if (!mutation.isPending) setConfirmDelete(false);
          }}
          onConfirm={() => {
            if (!mutation.isPending) mutation.mutate("delete");
          }}
        />
      )}
    </article>
  );
}
