import {
  AppWindow,
  KeyRound,
  LockKeyhole,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { SavedKey } from "@everything/key-contracts";
import { IconButton } from "@everything/ui/button";
import { keyTypeLabel } from "../model/key-formats.js";

/** Format a stored timestamp as a short date. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** A compact metadata card with explicit management actions and no secret preview. */
export function KeyCard({
  item,
  onRename,
  onDelete,
  onReplace,
  onUsage,
}: {
  item: SavedKey;
  onRename: () => void;
  onDelete: () => void;
  onReplace: () => void;
  onUsage: () => void;
}) {
  const generic = item.type === "generic";
  const removing = item.status === "removing";
  return (
    <article className="key-card" aria-busy={removing}>
      <div className="key-card-top">
        <span className="key-artwork">
          {generic ? (
            <LockKeyhole aria-hidden="true" />
          ) : (
            <KeyRound aria-hidden="true" />
          )}
        </span>
        <div className="key-card-actions">
          {generic && (
            <IconButton label={`Apps using ${item.name}`} onClick={onUsage}>
              <AppWindow aria-hidden="true" />
            </IconButton>
          )}
          {generic && item.owned && !removing && (
            <IconButton
              label={`Replace value of ${item.name}`}
              onClick={onReplace}
            >
              <RefreshCw aria-hidden="true" />
            </IconButton>
          )}
          {!removing && (
            <IconButton
              label={`${generic ? "Edit" : "Rename"} ${item.name}`}
              onClick={onRename}
            >
              <Pencil aria-hidden="true" />
            </IconButton>
          )}
          {!removing && (
            <IconButton label={`Delete ${item.name}`} onClick={onDelete}>
              <Trash2 aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </div>
      <h2>{item.name}</h2>
      <span className="key-type">{keyTypeLabel(item.type)}</span>
      {generic && item.description && (
        <p className="key-description">{item.description}</p>
      )}
      {item.availability && (
        <p className="key-availability">
          {item.availability === "ready"
            ? "Available to all teammates and Fleet"
            : item.availability === "pending"
              ? "Waiting for SSH availability"
              : "Stored only. SSH requires a supported private key without a passphrase."}
        </p>
      )}
      {generic && (
        <p className="key-availability" role={removing ? "status" : undefined}>
          {removing
            ? "Removing from apps… Everything keeps trying until no app has it."
            : item.owned
              ? "Added by you. Apps receive it only when attached."
              : "Added by another account. Only that account can attach it or replace its value."}
        </p>
      )}
      <p className="key-created">
        Added <time dateTime={item.createdAt}>{shortDate(item.createdAt)}</time>
        {generic && item.updatedAt && item.updatedAt !== item.createdAt && (
          <>
            {" · Value updated "}
            <time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time>
          </>
        )}
      </p>
    </article>
  );
}
