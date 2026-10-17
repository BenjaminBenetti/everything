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
import { useKeyDirectory } from "./key-directory-provider.js";
import { KeyMaterialField } from "./key-material-field.js";
import {
  keyFormats,
  keyTypeLabel,
  keyTypeOptions,
} from "../model/key-formats.js";

/** Create a key or rename metadata while keeping the secret in this dialog's local state only. */
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
  const [material, setMaterial] = useState("");
  const [reading, setReading] = useState(false);
  const [validation, setValidation] = useState("");
  const formId = useId();
  const directory = useKeyDirectory();
  const cache = useQueryClient();
  const { profile } = useSession();
  const save = useMutation({
    mutationFn: () =>
      item
        ? directory.rename(item.id, { name: name.trim() })
        : directory.create({
            name: name.trim(),
            type,
            material,
          }),
    onSuccess: async () => {
      setMaterial("");
      await cache.invalidateQueries({ queryKey: ["keys", profile?.subject] });
      onSaved(item ? "Key renamed." : "Key added.");
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
      setValidation("Upload or paste a supported key smaller than 32 KB.");
      return;
    }
    save.mutate();
  }

  return (
    <Dialog
      title={item ? "Rename key" : "Add key"}
      description={
        item
          ? "Choose a name that makes this key easy to find."
          : "Give your key a name, then upload a file or paste its contents."
      }
      dismissible={!busy}
      onClose={onClose}
      className="key-editor"
      footer={
        <div className="dialog-actions">
          <Button variant="light" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            form={formId}
            type="submit"
            disabled={busy || !name.trim() || (!item && !material.trim())}
          >
            {save.isPending ? "Saving…" : item ? "Save name" : "Add key"}
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
            placeholder="e.g. Development server"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {item ? (
          <p className="muted">Type: {keyTypeLabel(item.type)}</p>
        ) : (
          <>
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
              Key contents are encrypted when saved and won’t be shown again.
            </p>
          </>
        )}
        {(validation || save.isError) && (
          <p className="form-error" role="alert">
            {validation || save.error?.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}
