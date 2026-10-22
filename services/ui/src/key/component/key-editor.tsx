import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { KeyMaterialField } from "./key-material-field.js";
import {
  keyFormats,
  keyTypeLabel,
  keyTypeOptions,
} from "../model/key-formats.js";

/**
 * Create a key, or rename one and edit a generic credential's description, while keeping any
 * secret in this dialog's local state only.
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
  const [material, setMaterial] = useState("");
  const [reading, setReading] = useState(false);
  const [validation, setValidation] = useState("");
  const formId = useId();
  const directory = useKeyDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  const generic = type === "generic";
  const save = useMutation({
    // The value is read from this dialog's state, so it never becomes a cached mutation variable.
    mutationFn: () =>
      item
        ? directory.rename(item.id, {
            name: name.trim(),
            ...(generic ? { description: description.trim() } : {}),
          })
        : directory.create({
            name: name.trim(),
            type,
            material,
            ...(generic && description.trim()
              ? { description: description.trim() }
              : {}),
          }),
    onSuccess: async () => {
      setMaterial("");
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
      onClose();
    },
  });
  const busy = save.isPending || reading;

  /** Check the format without using the key and preserve drafts after failed requests. */
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setValidation("");
    if (
      !item &&
      (!keyFormats[type].accepts(material) ||
        new TextEncoder().encode(material).length > keyLimits.materialLength)
    ) {
      setValidation(keyFormats[type].submitMessage);
      return;
    }
    save.mutate();
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
      onClose={() => {
        setMaterial("");
        onClose();
      }}
      className="key-editor"
      footer={
        <div className="dialog-actions">
          <Button
            variant="light"
            disabled={busy}
            onClick={() => {
              setMaterial("");
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            form={formId}
            type="submit"
            disabled={busy || !name.trim() || (!item && !material.trim())}
          >
            {save.isPending
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
      <form id={formId} onSubmit={submit} aria-busy={busy}>
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
              value={material}
              disabled={save.isPending}
              onChange={(value) => {
                setMaterial(value);
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
        {(validation || save.isError) && (
          <p className="form-error" role="alert">
            {validation || credentialFailureMessage(save.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
