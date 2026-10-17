import { useId, useState, type ChangeEvent } from "react";
import { Upload } from "lucide-react";
import { keyLimits, type KeyType } from "@everything/key-contracts";
import { keyFormats } from "../model/key-formats.js";

/** Read a bounded text upload locally; only the enclosing editor submits its contents. */
export function KeyMaterialField({
  type,
  value,
  disabled,
  onChange,
  onFileName,
  onReadingChange,
}: {
  type: KeyType;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onFileName: (name: string) => void;
  onReadingChange: (reading: boolean) => void;
}) {
  const helpId = useId();
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [fileName, setFileName] = useState("");
  const format = keyFormats[type];

  /** Refuse oversized files before reading and keep failed uploads from replacing the draft. */
  async function upload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setFileError("");
    if (file.size > keyLimits.materialLength) {
      setFileError("Choose a key file smaller than 32 KB.");
      return;
    }
    setReading(true);
    onReadingChange(true);
    try {
      const text = await file.text();
      if (!format.accepts(text)) {
        setFileError(format.invalidMessage);
        return;
      }
      onChange(text);
      onFileName(file.name);
      setFileName(file.name);
    } catch {
      setFileError("This file couldn’t be read. Try choosing it again.");
    } finally {
      setReading(false);
      onReadingChange(false);
    }
  }

  return (
    <div className="key-material">
      <p className="muted" id={helpId}>
        {format.description}
      </p>
      <label className={`key-upload ${disabled || reading ? "disabled" : ""}`}>
        <Upload aria-hidden="true" />
        <span>
          <strong>{reading ? "Reading key…" : "Choose a key file"}</strong>
          <small>{fileName || "Up to 32 KB"}</small>
        </span>
        <input
          className="sr-only"
          type="file"
          aria-label="Key file"
          disabled={disabled || reading}
          onChange={(event) => void upload(event)}
        />
      </label>
      <label className="field">
        Key contents
        <textarea
          rows={6}
          value={value}
          placeholder={format.placeholder}
          maxLength={keyLimits.materialLength}
          disabled={disabled || reading}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={helpId}
          onChange={(event) => {
            setFileName("");
            setFileError("");
            onChange(event.target.value);
          }}
        />
      </label>
      {fileError && (
        <p className="form-error" role="alert">
          {fileError}
        </p>
      )}
    </div>
  );
}
