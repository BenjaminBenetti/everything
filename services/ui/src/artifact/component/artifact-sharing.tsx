import { useId, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Globe, Lock } from "lucide-react";
import { Button, IconButton } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import type { ArtifactSummary } from "@everything/artifact-contracts";
import { useAppVisibility } from "../hook/use-app-visibility.js";
import {
  isViewable,
  publicConsequences,
  visibilityLabels,
} from "../model/artifact-presentation.js";

/** Show who can open the app, and let its owner make it public or private again. */
export function ArtifactSharing({
  artifact,
  unavailable,
}: {
  artifact: ArtifactSummary;
  unavailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = visibilityLabels[artifact.visibility];
  const Icon = artifact.visibility === "public" ? Globe : Lock;
  return (
    <>
      <button
        type="button"
        className={`artifact-sharing-trigger sharing-${artifact.visibility}`}
        aria-label={`${label.name}: change who can open ${artifact.title}`}
        aria-haspopup="dialog"
        disabled={unavailable}
        onClick={(event) => {
          event.currentTarget.setAttribute("data-dialog-return", "");
          setOpen(true);
        }}
      >
        <Icon aria-hidden="true" />
        <span>{label.name}</span>
      </button>
      {open && (
        <SharingDialog artifact={artifact} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * Explain what public means before the owner chooses it, and show the link once it is public. The
 * shown state is always the app as the server last returned it, never an assumed success.
 */
function SharingDialog({
  artifact,
  onClose,
}: {
  artifact: ArtifactSummary;
  onClose: () => void;
}) {
  const mutation = useAppVisibility(artifact);
  const link = useRef<HTMLInputElement>(null);
  const linkId = useId();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [announcement, setAnnouncement] = useState("");
  const isPublic = artifact.visibility === "public";
  const pending = mutation.isPending;
  // A failed request may still have been saved; once the server shows the requested state, it did.
  const failed = mutation.isError && artifact.visibility !== mutation.variables;

  /** Ask the server for the other visibility, announcing only what it confirms. */
  function change(): void {
    if (pending) return;
    setAnnouncement("");
    setCopy("idle");
    mutation.mutate(isPublic ? "private" : "public", {
      onSuccess: (saved) =>
        setAnnouncement(
          saved.visibility === "public"
            ? "This app is public now. Anyone with the link can use it."
            : "This app is private now. New visits need you or a teammate.",
        ),
    });
  }

  /** Copy the public link; if the browser refuses, select it so it can be copied by hand. */
  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(artifact.url);
      setCopy("copied");
    } catch {
      setCopy("failed");
      link.current?.select();
    }
  }

  return (
    <Dialog
      className="artifact-sharing-dialog"
      title={
        isPublic
          ? `“${artifact.title}” is public`
          : `Make “${artifact.title}” public?`
      }
      description={visibilityLabels[artifact.visibility].meaning}
      dismissible={!pending}
      onClose={onClose}
      footer={
        <div className="dialog-actions confirmation-actions">
          <Button variant="light" disabled={pending} onClick={onClose}>
            {isPublic ? "Close" : "Cancel"}
          </Button>
          <Button
            autoFocus={!isPublic}
            variant={isPublic ? "light" : "primary"}
            disabled={pending}
            onClick={change}
          >
            {pending
              ? isPublic
                ? "Making private…"
                : "Making public…"
              : isPublic
                ? "Make private"
                : "Make public"}
          </Button>
        </div>
      }
    >
      <div className="artifact-sharing" aria-busy={pending}>
        {isPublic ? (
          <>
            <label className="artifact-sharing-label" htmlFor={linkId}>
              Public link
            </label>
            <div className="artifact-sharing-link">
              <input
                ref={link}
                id={linkId}
                readOnly
                value={artifact.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <IconButton
                autoFocus
                label={copy === "copied" ? "Link copied" : "Copy link"}
                onClick={() => void copyLink()}
              >
                {copy === "copied" ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </IconButton>
              <a
                className="icon-button"
                href={artifact.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open link in a new tab"
                title="Open link in a new tab"
              >
                <ExternalLink aria-hidden="true" />
              </a>
            </div>
            {copy === "failed" && (
              <p className="form-error" role="alert">
                Your browser didn’t allow copying. The link is selected, so you
                can copy it yourself.
              </p>
            )}
            {!isViewable(artifact.status) && (
              <p className="artifact-sharing-note">
                This app isn’t running, so visitors see a notice until it’s
                published or started.
              </p>
            )}
            <p className="artifact-sharing-note">
              Making it private stops new visits right away. People keep
              anything they’ve already downloaded.
            </p>
          </>
        ) : (
          <ul className="artifact-sharing-consequences">
            {publicConsequences(artifact).map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        )}
        {failed && (
          <p className="form-error" role="alert">
            {mutation.variables === "public"
              ? "Couldn’t make this app public. Check your connection and try again."
              : "Couldn’t make this app private. Check your connection and try again."}
          </p>
        )}
        <p className="sr-only" role="status">
          {announcement}
        </p>
      </div>
    </Dialog>
  );
}
