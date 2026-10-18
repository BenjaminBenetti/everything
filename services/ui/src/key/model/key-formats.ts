import { keyTypes, type KeyType } from "@everything/key-contracts";
import { isSshKeyMaterial } from "@everything/key-contracts/ssh";

/** Type-specific upload guidance and validation, separate from the generic editor. */
export const keyFormats: Record<
  KeyType,
  {
    readonly description: string;
    readonly placeholder: string;
    readonly invalidMessage: string;
    /** Recognize supported file formats without using the key. */
    readonly accepts: (material: string) => boolean;
  }
> = {
  ssh: {
    description:
      "Upload or paste an Ed25519, ECDSA, or RSA private key without a passphrase, in OpenSSH or PEM format, to make it available to all teammates and Fleet in this installation. Public keys, passphrase-protected keys, and DSA keys are stored only and can’t be used for SSH authentication.",
    placeholder: "Paste your key here…",
    invalidMessage:
      "This file isn’t a supported SSH key format. Choose an SSH public key or an OpenSSH or PEM private key.",
    accepts: isSshKeyMaterial,
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
