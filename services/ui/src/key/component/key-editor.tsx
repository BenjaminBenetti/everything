import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  keyLimits,
  keyTypes,
  type KeyType,
  type SavedKey,
} from "@everything/key-contracts";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { Select } from "@everything/ui/select";
import { useSession } from "../../session/component/session-provider.js";
import { credentialFailureMessage } from "../../artifact/model/credential-presentation.js";
import { useKeyDirectory } from "./key-directory-provider.js";
import { useWriteOnlySubmission } from "../hook/use-write-only-submission.js";
import { KeyMaterialField } from "./key-material-field.js";
import {
  keyFormats,
  keyTypeLabel,
  keyTypeOptions,
} from "../model/key-formats.js";

/**
 * Create a key, or rename one and edit a generic credential's description. A new key's contents
 * stay in this dialog's submission only, never in a shared cache, and are erased once saved or
 * when the dialog closes.
 */
export function KeyEditor({
  item,
  onClose,
  onSaved,
}: {
  item?: SavedKey;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [type, setType] = useState<KeyType>(item?.type ?? keyTypes[0].id);
  const [description, setDescription] = useState(item?.description ?? "");
  const [reading, setReading] = useState(false);
  const [validation, setValidation] = useState("");
  const formId = useId();
  const directory = useKeyDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  const submission = useWriteOnlySubmission<SavedKey>();
  const saving = submission.state.status === "pending";
  const failure =
    submission.state.status === "failed" ? submission.state.error : undefined;
  const generic = type === "generic";
  const busy = saving || reading;

  /** Erase any typed contents, then close. */
  function close(): void {
    submission.close();
    onClose();
  }

  /** Check the format without using the key and preserve drafts after failed requests. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setValidation("");
    if (
      !item &&
      (!keyFormats[type].accepts(submission.draft) ||
        new TextEncoder().encode(submission.draft).length >
          keyLimits.materialLength)
    ) {
      setValidation(keyFormats[type].submitMessage);
      return;
    }
    const keyName = name.trim();
    const keyDescription = description.trim();
    const outcome = await submission.submit((material) =>
      item
        ? directory.rename(item.id, {
            name: keyName,
            ...(generic ? { description: keyDescription } : {}),
          })
        : directory.create({
            name: keyName,
            type,
            material,
            ...(generic && keyDescription
              ? { description: keyDescription }
              : {}),
          }),
    );
    if (outcome.status !== "succeeded") return;
    await cache.invalidateQueries({ queryKey: ["keys", profile?.subject] });
    onSaved(
      item
        ? generic
          ? "Credential updated."
          : "Key renamed."
        : generic
          ? "Credential added. Attach it to an app from Apps to give that app’s backend the value."
          : "Key added.",
    );
    close();
  }

  return (
    <Dialog
      title={item ? (generic ? "Edit credential" : "Rename key") : "Add key"}
      description={
        item
          ? generic
            ? "Change the name or description. The value stays as it is, and apps keep receiving it."
            : "Choose a name that makes this key easy to find."
          : "Give your key a name, then upload a file or paste its contents."
      }
      dismissible={!busy}
      onClose={close}
      className="key-editor"
      footer={
        <div className="dialog-actions">
          <Button variant="light" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            form={formId}
            type="submit"
            disabled={
              busy || !name.trim() || (!item && !submission.draft.trim())
            }
          >
            {saving
              ? "Saving…"
              : item
                ? generic
                  ? "Save changes"
                  : "Save name"
                : "Add key"}
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        aria-busy={busy}
      >
        <label className="field">
          Key name
          <input
            autoFocus
            required
            maxLength={keyLimits.nameLength}
            placeholder={
              generic ? "e.g. slack-bot-token" : "e.g. Development server"
            }
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {item ? (
          <p className="muted">Type: {keyTypeLabel(item.type)}</p>
        ) : (
          <div className="field">
            <span>Type</span>
            <Select
              label="Key type"
              value={type}
              options={keyTypeOptions}
              placeholder="Choose a type"
              disabled={busy}
              onValueChange={(value) => {
                const next = keyTypes.find((entry) => entry.id === value);
                if (next) {
                  setType(next.id);
                  setValidation("");
                }
              }}
            />
          </div>
        )}
        {generic && (
          <label className="field">
            Description (optional)
            <input
              maxLength={keyLimits.descriptionLength}
              placeholder="What it’s for, such as which Slack workspace"
              value={description}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        )}
        {!item && (
          <>
            <KeyMaterialField
              type={type}
              value={submission.draft}
              disabled={saving}
              onChange={(value) => {
                submission.edit(value);
                setValidation("");
              }}
              onFileName={(value) =>
                setName(
                  (current) => current || value.slice(0, keyLimits.nameLength),
                )
              }
              onReadingChange={setReading}
            />
            <p className="key-storage-note">
              {generic
                ? "The value is encrypted when saved and won’t be shown again. No app receives it until you or a teammate attach it, and the backend of an app it’s attached to can read it."
                : "Key contents are encrypted when saved and won’t be shown again."}
            </p>
          </>
        )}
        {(validation || failure !== undefined) && (
          <p className="form-error" role="alert">
            {validation || credentialFailureMessage(failure)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
