import { keyTypes, type KeyType } from "@everything/key-contracts";
import { isSshKeyMaterial } from "@everything/key-contracts/ssh";
import { isGenericCredentialValue } from "@everything/key-contracts/generic";

/** Type-specific upload guidance and validation, separate from the generic editor. */
export const keyFormats: Record<
  KeyType,
  {
    readonly description: string;
    readonly placeholder: string;
    /** Accessible name of the field holding the secret. */
    readonly contentLabel: string;
    /** Accessible name of the file input. */
    readonly fileLabel: string;
    /** Visible prompt on the file picker. */
    readonly fileAction: string;
    /** Shown when an uploaded file can't be used. */
    readonly invalidMessage: string;
    /** Shown when the pasted or uploaded contents can't be saved. */
    readonly submitMessage: string;
    /** Recognize supported file formats without using the key. */
    readonly accepts: (material: string) => boolean;
  }
> = {
  ssh: {
    description:
      "Upload or paste an Ed25519, ECDSA, or RSA private key without a passphrase, in OpenSSH or PEM format, to make it available to all teammates and Fleet in this installation. Public keys, passphrase-protected keys, and DSA keys are stored only and can’t be used for SSH authentication.",
    placeholder: "Paste your key here…",
    contentLabel: "Key contents",
    fileLabel: "Key file",
    fileAction: "Choose a key file",
    invalidMessage:
      "This file isn’t a supported SSH key format. Choose an SSH public key or an OpenSSH or PEM private key.",
    submitMessage: "Upload or paste a supported key smaller than 32 KB.",
    accepts: isSshKeyMaterial,
  },
  generic: {
    description:
      "Paste or upload a secret, such as an API token. It’s saved exactly as entered, including spaces and line breaks. Apps receive it as an environment variable only after you or a teammate attach it to them.",
    placeholder: "Paste the value here…",
    contentLabel: "Value",
    fileLabel: "Value file",
    fileAction: "Choose a file",
    invalidMessage:
      "This file can’t be used as a value. Choose a text file smaller than 32 KB.",
    submitMessage:
      "Enter a value smaller than 32 KB. It can’t be blank or contain NUL characters.",
    accepts: isGenericCredentialValue,
  },
};

/** Reuse the same catalog in the creation dialog, filter, and cards. */
export const keyTypeOptions = keyTypes.map(({ id, label }) => ({
  value: id,
  label,
}));

/** Provide readable labels while keeping stored type identifiers independent of copy. */
export function keyTypeLabel(type: KeyType): string {
  return keyTypes.find((item) => item.id === type)?.label ?? type;
}
