import { KeyRound, Pencil, Trash2 } from "lucide-react";
import type { SavedKey } from "@everything/key-contracts";
import { IconButton } from "@everything/ui/button";
import { keyTypeLabel } from "../model/key-formats.js";

/** A compact metadata card with explicit management actions and no secret preview. */
export function KeyCard({
  item,
  onRename,
  onDelete,
}: {
  item: SavedKey;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="key-card">
      <div className="key-card-top">
        <span className="key-artwork">
          <KeyRound aria-hidden="true" />
        </span>
        <div className="key-card-actions">
          <IconButton label={`Rename ${item.name}`} onClick={onRename}>
            <Pencil aria-hidden="true" />
          </IconButton>
          <IconButton label={`Delete ${item.name}`} onClick={onDelete}>
            <Trash2 aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <h2>{item.name}</h2>
      <span className="key-type">{keyTypeLabel(item.type)}</span>
      {item.availability && (
        <p className="key-availability">
          {item.availability === "ready"
            ? "Available to all teammates and Fleet"
            : item.availability === "pending"
              ? "Waiting for SSH availability"
              : "Stored only. SSH requires a supported private key without a passphrase."}
        </p>
      )}
      <p className="key-created">
        Added{" "}
        <time dateTime={item.createdAt}>
          {new Date(item.createdAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </time>
      </p>
    </article>
  );
}
