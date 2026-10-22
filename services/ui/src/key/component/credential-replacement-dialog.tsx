import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SavedKey } from "@everything/key-contracts";
import { isGenericCredentialValue } from "@everything/key-contracts/generic";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { useSession } from "../../session/component/session-provider.js";
import {
  credentialFailureMessage,
  replacementProgress,
} from "../../artifact/model/credential-presentation.js";
import type { KeyValueReplacement } from "../interface/key-directory.js";
import { useWriteOnlySubmission } from "../hook/use-write-only-submission.js";
import {
  useCredentialUsage,
  useKeyDirectory,
} from "./key-directory-provider.js";
import { CredentialUsageList } from "./credential-usage-list.js";
import { KeyMaterialField } from "./key-material-field.js";
import { keyFormats } from "../model/key-formats.js";

/**
 * Replace a generic credential's value: warn which apps restart, send the new value once, erase
 * it, and then follow each app's restart until it settles. The value lives only in this dialog's
 * submission, never in a shared cache.
 */
export function CredentialReplacementDialog({
  item,
  onClose,
}: {
  item: SavedKey;
  onClose: () => void;
}) {
  const [reading, setReading] = useState(false);
  const [validation, setValidation] = useState("");
  /** When the latest attempt started; usage read before then says nothing about the new value. */
  const [submittedAt, setSubmittedAt] = useState(0);
  const formId = useId();
  const directory = useKeyDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  const submission = useWriteOnlySubmission<KeyValueReplacement>();
  const saved =
    submission.state.status === "succeeded"
      ? submission.state.result
      : undefined;
  const failure =
    submission.state.status === "failed" ? submission.state.error : undefined;
  const usage = useCredentialUsage(item.id, saved !== undefined);
  const latest =
    usage.data && usage.dataUpdatedAt >= submittedAt ? usage.data : undefined;
  const saving = submission.state.status === "pending";
  const busy = saving || reading;

  /** Erase the draft whenever the dialog closes. */
  function close(): void {
    submission.close();
    onClose();
  }

  /** Check the value locally, then send it once. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (!isGenericCredentialValue(submission.draft)) {
      setValidation(keyFormats.generic.submitMessage);
      return;
    }
    setValidation("");
    setSubmittedAt(Date.now());
    const outcome = await submission.submit((material) =>
      directory.replaceValue(item.id, { material }),
    );
    if (outcome.status !== "succeeded") return;
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["keys", profile?.subject] }),
      cache.invalidateQueries({ queryKey: ["artifacts", profile?.subject] }),
    ]);
  }

  if (saved)
    return (
      <Dialog
        title="Value replaced"
        description={replacementProgress(saved.rollout, latest)}
        onClose={close}
        className="credential-dialog"
        footer={
          <div className="dialog-actions">
            <Button onClick={close}>Done</Button>
          </div>
        }
      >
        <div className="credential-dialog-section" aria-live="polite">
          <CredentialUsageList
            usage={{
              data: latest,
              isPending: !latest && !usage.isError,
              isError: usage.isError,
              isFetching: usage.isFetching,
            }}
            empty="No app uses this credential yet."
            onRetry={() => void usage.refetch()}
          />
        </div>
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
            disabled={busy || !submission.draft.trim()}
          >
            {saving ? "Saving…" : "Replace value"}
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        aria-busy={busy}
      >
        <div className="credential-dialog-section">
          <p className="credential-notice">
            Saving restarts these apps so they use the new value:
          </p>
          <CredentialUsageList
            usage={usage}
            empty="No app uses this credential yet, so nothing restarts."
            onRetry={() => void usage.refetch()}
          />
        </div>
        <KeyMaterialField
          type="generic"
          value={submission.draft}
          disabled={saving}
          onChange={(value) => {
            submission.edit(value);
            setValidation("");
          }}
          onFileName={() => {}}
          onReadingChange={setReading}
        />
        <p className="key-storage-note">
          The new value is encrypted when saved and won’t be shown again.
        </p>
        {(validation || failure !== undefined) && (
          <p className="form-error" role="alert">
            {validation || credentialFailureMessage(failure)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
