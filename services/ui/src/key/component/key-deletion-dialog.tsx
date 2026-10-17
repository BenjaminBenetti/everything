import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SavedKey } from "@everything/key-contracts";
import { ConfirmationDialog } from "@everything/ui/confirmation-dialog";
import { useSession } from "../../session/component/session-provider.js";
import { useKeyDirectory } from "./key-directory-provider.js";

/** Confirm deletion and keep the dialog open with retry feedback on failure. */
export function KeyDeletionDialog({
  item,
  onClose,
  onDeleted,
}: {
  item: SavedKey;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const directory = useKeyDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  const remove = useMutation({
    mutationFn: () => directory.delete(item.id),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["keys", profile?.subject] });
      onDeleted();
      onClose();
    },
  });
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
