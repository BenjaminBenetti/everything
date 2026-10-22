import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SavedKey } from "@everything/key-contracts";
import type { CredentialUse } from "@everything/artifact-contracts/credential";
import { Button } from "@everything/ui/button";
import { ConfirmationDialog } from "@everything/ui/confirmation-dialog";
import { Dialog } from "@everything/ui/dialog";
import { useSession } from "../../session/component/session-provider.js";
import { useArtifactLibrary } from "../../artifact/component/artifact-library-provider.js";
import { credentialFailureMessage } from "../../artifact/model/credential-presentation.js";
import { useCredentialUsage } from "./key-directory-provider.js";
import { CredentialUsageList } from "./credential-usage-list.js";

/** Show which apps receive a generic credential, and take it away from one of them. */
export function CredentialUsageDialog({
  item,
  onClose,
}: {
  item: SavedKey;
  onClose: () => void;
}) {
  const [removing, setRemoving] = useState<CredentialUse | null>(null);
  const usage = useCredentialUsage(item.id, true);
  const library = useArtifactLibrary();
  const cache = useQueryClient();
  const { profile } = useSession();
  const detach = useMutation({
    mutationFn: (use: CredentialUse) =>
      library.detachCredential(use.appId, use.env),
    onSuccess: async () => {
      setRemoving(null);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["keys", profile?.subject] }),
        cache.invalidateQueries({ queryKey: ["artifacts", profile?.subject] }),
      ]);
    },
  });
  return (
    <>
      <Dialog
        title={`Apps using ${item.name}`}
        description="These apps’ backends receive this credential as an environment variable. Removing it restarts the app without the value."
        onClose={onClose}
        className="credential-dialog"
        footer={
          <div className="dialog-actions">
            <Button onClick={onClose}>Done</Button>
          </div>
        }
      >
        <div className="credential-dialog-section" aria-live="polite">
          <CredentialUsageList
            usage={usage}
            empty="No app uses this credential. Attach it to an app from Apps."
            {...(item.status ? {} : { onRemove: setRemoving })}
          />
        </div>
      </Dialog>
      {removing && (
        <ConfirmationDialog
          title="Remove from app?"
          description={`“${removing.title}” stops receiving ${removing.env} and restarts without it.`}
          confirmLabel="Remove credential"
          pendingLabel="Removing…"
          pending={detach.isPending}
          {...(detach.isError
            ? { error: credentialFailureMessage(detach.error) }
            : {})}
          onCancel={() => {
            if (!detach.isPending) {
              detach.reset();
              setRemoving(null);
            }
          }}
          onConfirm={() => {
            if (!detach.isPending) detach.mutate(removing);
          }}
        />
      )}
    </>
  );
}
