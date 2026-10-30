import { FileText, RotateCcw, X } from "lucide-react";
import { IconButton } from "@everything/ui/button";
import { formatSize, type DraftAttachment } from "../model/attachment-draft.js";

/** What a file is doing, in words for its label and for screen readers. */
function statusText(item: DraftAttachment): string {
  switch (item.status) {
    case "ready":
      return `${formatSize(item.size)}, ready to send`;
    case "failed":
      return item.error ?? "Upload stopped";
    case "uploading":
      return item.size
        ? `Uploading, ${Math.floor((item.received / item.size) * 100)}%`
        : "Uploading";
  }
}

/**
 * The files attached to the draft: image previews and file chips with upload progress, a retry for
 * stopped uploads, and removal. Files the composer couldn't add are explained above them.
 */
export function ComposerAttachments({
  items,
  problems,
  onRetry,
  onRemove,
  onDismissProblems,
}: {
  items: readonly DraftAttachment[];
  problems: readonly string[];
  onRetry: (key: string) => void;
  onRemove: (key: string) => void;
  onDismissProblems: () => void;
}) {
  if (!items.length && !problems.length) return null;
  return (
    <div className="chat-attachments">
      {problems.length > 0 && (
        <div className="chat-attachments-problems" role="alert">
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <IconButton label="Dismiss" onClick={onDismissProblems}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
      )}
      {items.length > 0 && (
        <ul className="chat-attachment-list" aria-label="Files to send">
          {items.map((item) => (
            <li
              key={item.key}
              className="chat-attachment"
              data-status={item.status}
              aria-label={`${item.name}: ${statusText(item)}`}
            >
              {item.preview ? (
                <img
                  className="chat-attachment-thumbnail"
                  src={item.preview}
                  alt=""
                  aria-hidden="true"
                />
              ) : (
                <span className="chat-attachment-icon" aria-hidden="true">
                  <FileText />
                </span>
              )}
              <span className="chat-attachment-details" aria-hidden="true">
                <span className="chat-attachment-name">{item.name}</span>
                <span className="chat-attachment-status">
                  {statusText(item)}
                </span>
                {item.status === "uploading" && (
                  <progress
                    className="chat-attachment-progress"
                    max={item.size || 1}
                    value={item.received}
                  />
                )}
              </span>
              {item.status === "failed" && item.retryable && (
                <IconButton
                  label={`Retry uploading ${item.name}`}
                  onClick={() => onRetry(item.key)}
                >
                  <RotateCcw aria-hidden="true" />
                </IconButton>
              )}
              <IconButton
                label={
                  item.status === "uploading"
                    ? `Cancel uploading ${item.name}`
                    : `Remove ${item.name}`
                }
                onClick={() => onRemove(item.key)}
              >
                <X aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
