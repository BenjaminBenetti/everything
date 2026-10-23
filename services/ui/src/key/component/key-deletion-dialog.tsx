import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SavedKey } from "@everything/key-contracts";
import { Button } from "@everything/ui/button";
import { ConfirmationDialog } from "@everything/ui/confirmation-dialog";
import { Dialog } from "@everything/ui/dialog";
import { useSession } from "../../session/component/session-provider.js";
import {
  credentialFailureMessage,
  deletionOutcome,
} from "../../artifact/model/credential-presentation.js";
import {
  useCredentialUsage,
  useKeyDirectory,
} from "./key-directory-provider.js";
import { CredentialUsageList } from "./credential-usage-list.js";

/** Confirm deletion and keep the dialog open with retry feedback on failure. */
export function KeyDeletionDialog({
  item,
  onClose,
  onDeleted,
}: {
  item: SavedKey;
  onClose: () => void;
  onDeleted: (message: string) => void;
}) {
  const directory = useKeyDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  const remove = useMutation({
    mutationFn: () => directory.delete(item.id),
    onSuccess: async (rollout) => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["keys", profile?.subject] }),
        cache.invalidateQueries({ queryKey: ["artifacts", profile?.subject] }),
      ]);
      onDeleted(
        item.type === "generic" ? deletionOutcome(rollout) : "Key deleted.",
      );
      onClose();
    },
  });
  if (item.type === "generic")
    return (
      <CredentialDeletion
        item={item}
        pending={remove.isPending}
        error={remove.isError ? credentialFailureMessage(remove.error) : ""}
        onCancel={onClose}
        onConfirm={() => {
          if (!remove.isPending) remove.mutate();
        }}
      />
    );
  return (
    <ConfirmationDialog
      title="Delete key?"
      description={`Delete “${item.name}” and its stored contents? This can’t be undone.`}
      confirmLabel="Delete key"
      pendingLabel="Deleting…"
      pending={remove.isPending}
      {...(remove.isError ? { error: remove.error.message } : {})}
      onCancel={onClose}
      onConfirm={() => {
        if (!remove.isPending) remove.mutate();
      }}
    />
  );
}

/** Warn which apps lose a generic credential and restart without it before it's deleted. */
function CredentialDeletion({
  item,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  item: SavedKey;
  pending: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const usage = useCredentialUsage(item.id);
  return (
    <Dialog
      role="alertdialog"
      title="Delete credential?"
      description={`Delete “${item.name}” and its stored value? This can’t be undone. Apps that use it lose access and restart without it.`}
      onClose={onCancel}
      dismissible={!pending}
      footer={
        <div className="dialog-actions confirmation-actions">
          <Button
            autoFocus
            variant="light"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button variant="danger" disabled={pending} onClick={onConfirm}>
            {pending ? "Deleting…" : "Delete credential"}
          </Button>
        </div>
      }
    >
      <div className="credential-dialog-section" aria-busy={pending}>
        <CredentialUsageList
          usage={usage}
          empty="No app uses it, so no app restarts."
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
