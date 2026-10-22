import { useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import type { SavedKey } from "@everything/key-contracts";
import { Button } from "@everything/ui/button";
import { SearchInput } from "@everything/ui/search-input";
import { Select } from "@everything/ui/select";
import { PageHeading } from "../../workspace/component/page-heading.js";
import { useKeys } from "../component/key-directory-provider.js";
import { KeyCard } from "../component/key-card.js";
import { KeyEditor } from "../component/key-editor.js";
import { KeyDeletionDialog } from "../component/key-deletion-dialog.js";
import { CredentialReplacementDialog } from "../component/credential-replacement-dialog.js";
import { CredentialUsageDialog } from "../component/credential-usage-dialog.js";
import { keyTypeLabel, keyTypeOptions } from "../model/key-formats.js";

type KeyDialog =
  | { kind: "add" }
  | { kind: "rename" | "delete" | "replace" | "usage"; item: SavedKey };

/** Browse and manage named keys with independent name search and type filtering. */
export function KeysPage() {
  const keys = useKeys();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [dialog, setDialog] = useState<KeyDialog | null>(null);
  const [message, setMessage] = useState("");
  const term = search.trim().toLocaleLowerCase();
  const filtered =
    keys.data?.filter(
      (key) =>
        (type === "all" || key.type === type) &&
        `${key.name} ${keyTypeLabel(key.type)}`
          .toLocaleLowerCase()
          .includes(term),
    ) ?? [];
  const hasFilter = !!term || type !== "all";

  /** Remember the opener for shared dialog focus restoration. */
  function open(next: KeyDialog): void {
    document
      .querySelector("[data-dialog-return]")
      ?.removeAttribute("data-dialog-return");
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.setAttribute("data-dialog-return", "");
    setMessage("");
    setDialog(next);
  }

  return (
    <div className="content-inner keys-page">
      <PageHeading
        title="Keys"
        description="Manage the SSH keys and credentials shared across this installation."
        action={
          <Button onClick={() => open({ kind: "add" })}>
            <Plus aria-hidden="true" />
            Add key
          </Button>
        }
      />
      <div className="list-tools key-list-tools">
        <h2 className="section-label">
          Shared keys <span>{keys.data?.length ?? "—"}</span>
        </h2>
        <div className="key-filters">
          <SearchInput
            label="Search keys"
            placeholder="Find a key…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            label="Filter by type"
            value={type}
            options={[{ value: "all", label: "All types" }, ...keyTypeOptions]}
            placeholder="All types"
            onValueChange={setType}
          />
        </div>
      </div>
      {message && (
        <p className="key-feedback" role="status">
          {message}
        </p>
      )}
      {keys.isPending && (
        <p className="status-panel" role="status">
          Loading keys…
        </p>
      )}
      {keys.isError && (
        <div className="status-panel" role="alert">
          <p>{keys.error.message}</p>
          <Button variant="light" onClick={() => void keys.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {!keys.isPending && !keys.isError && (
        <>
          {keys.data.length === 0 && !hasFilter ? (
            <div className="key-empty">
              <KeyRound aria-hidden="true" />
              <h2>Keys, in one place</h2>
              <p>Add your first key to get started.</p>
              <Button variant="light" onClick={() => open({ kind: "add" })}>
                <Plus aria-hidden="true" />
                Add your first key
              </Button>
            </div>
          ) : (
            <div className="key-grid">
              {filtered.map((item) => (
                <KeyCard
                  key={item.id}
                  item={item}
                  onRename={() => open({ kind: "rename", item })}
                  onDelete={() => open({ kind: "delete", item })}
                  onReplace={() => open({ kind: "replace", item })}
                  onUsage={() => open({ kind: "usage", item })}
                />
              ))}
              {!hasFilter && (
                <button
                  className="new-card new-key-card"
                  onClick={() => open({ kind: "add" })}
                >
                  <Plus aria-hidden="true" />
                  <span>
                    <strong>Add a key</strong>
                    <small>An SSH key or a credential for your apps</small>
                  </span>
                </button>
              )}
            </div>
          )}
          {hasFilter && filtered.length === 0 && (
            <div className="empty-search" role="status">
              <p>No matching keys. Try another name or type.</p>
              <Button
                variant="light"
                onClick={() => {
                  setSearch("");
                  setType("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
        </>
      )}
      {dialog?.kind === "add" && (
        <KeyEditor onClose={() => setDialog(null)} onSaved={setMessage} />
      )}
      {dialog?.kind === "rename" && (
        <KeyEditor
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSaved={setMessage}
        />
      )}
      {dialog?.kind === "delete" && (
        <KeyDeletionDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onDeleted={setMessage}
        />
      )}
      {dialog?.kind === "replace" && (
        <CredentialReplacementDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "usage" && (
        <CredentialUsageDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
