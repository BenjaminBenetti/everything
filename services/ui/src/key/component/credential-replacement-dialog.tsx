import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SavedKey } from "@everything/key-contracts";
import { isGenericCredentialValue } from "@everything/key-contracts/generic";
import type { CredentialRollout } from "@everything/artifact-contracts/credential";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { useSession } from "../../session/component/session-provider.js";
import {
  credentialFailureMessage,
  replacementOutcome,
} from "../../artifact/model/credential-presentation.js";
import {
  useCredentialUsage,
  useKeyDirectory,
} from "./key-directory-provider.js";
import { CredentialUsageList } from "./credential-usage-list.js";
import { KeyMaterialField } from "./key-material-field.js";
import { keyFormats } from "../model/key-formats.js";

/**
 * Replace a generic credential's value: warn which apps restart, send the new value once, forget
 * it, and then follow each app's restart until it settles.
 */
export function CredentialReplacementDialog({
  item,
  onClose,
}: {
  item: SavedKey;
  onClose: () => void;
}) {
  const [material, setMaterial] = useState("");
  const [reading, setReading] = useState(false);
  const [validation, setValidation] = useState("");
  const [rollout, setRollout] = useState<CredentialRollout | null>(null);
  const formId = useId();
  const directory = useKeyDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  const usage = useCredentialUsage(item.id, rollout !== null);
  const replace = useMutation({
    // The value is read from this dialog's state, so it never becomes a cached mutation variable.
    mutationFn: () => directory.replaceValue(item.id, { material }),
    onSuccess: async (result) => {
      setMaterial("");
      setRollout(result.rollout);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["keys", profile?.subject] }),
        cache.invalidateQueries({ queryKey: ["artifacts", profile?.subject] }),
      ]);
    },
  });
  const busy = replace.isPending || reading;

  /** Forget the draft whenever the dialog closes. */
  function close(): void {
    setMaterial("");
    onClose();
  }

  /** Check the value locally, then send it once. */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;
    if (!isGenericCredentialValue(material)) {
      setValidation(keyFormats.generic.submitMessage);
      return;
    }
    setValidation("");
    replace.mutate();
  }

  if (rollout)
    return (
      <Dialog
        title="Value replaced"
        description={replacementOutcome(rollout)}
        onClose={close}
        className="credential-dialog"
        footer={
          <div className="dialog-actions">
            <Button onClick={close}>Done</Button>
          </div>
        }
      >
        {rollout.usage && (
          <div className="credential-dialog-section" aria-live="polite">
            <CredentialUsageList
              usage={usage}
              empty="No app uses this credential yet."
            />
          </div>
        )}
      </Dialog>
    );

  return (
    <Dialog
      title="Replace value"
      description={`Save a new value for “${item.name}”. The old value can’t be shown or restored afterwards.`}
      dismissible={!busy}
      onClose={close}
      className="key-editor credential-dialog"
      footer={
        <div className="dialog-actions">
          <Button variant="light" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            form={formId}
            type="submit"
            disabled={busy || !material.trim()}
          >
            {replace.isPending ? "Saving…" : "Replace value"}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} aria-busy={busy}>
        <div className="credential-dialog-section">
          <p className="credential-notice">
            Saving restarts these apps so they use the new value:
          </p>
          <CredentialUsageList
            usage={usage}
            empty="No app uses this credential yet, so nothing restarts."
          />
        </div>
        <KeyMaterialField
          type="generic"
          value={material}
          disabled={replace.isPending}
          onChange={(value) => {
            setMaterial(value);
            setValidation("");
          }}
          onFileName={() => {}}
          onReadingChange={setReading}
        />
        <p className="key-storage-note">
          The new value is encrypted when saved and won’t be shown again.
        </p>
        {(validation || replace.isError) && (
          <p className="form-error" role="alert">
            {validation || credentialFailureMessage(replace.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
