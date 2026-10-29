/** Bounds shared by uploads, request validation, and persistence. */
export const keyLimits = {
  nameLength: 128,
  typeLength: 64,
  /** Largest stored value, in UTF-8 bytes. */
  materialLength: 32768,
  descriptionLength: 500,
} as const;

/** Extend this catalog as additional key formats become available. */
export const keyTypes = [
  { id: "ssh", label: "SSH" },
  { id: "generic", label: "Generic credential" },
] as const;
export type KeyType = (typeof keyTypes)[number]["id"];

/** Runtime availability is metadata, independent of the stored secret and its format. */
export type KeyAvailability = "pending" | "ready" | "unavailable";

/** A deleted generic credential that an app's process may still hold until it is replaced. */
export type KeyStatus = "removing";

/** Public metadata deliberately excludes both plaintext and encrypted key material. */
export interface SavedKey {
  readonly id: string;
  readonly name: string;
  readonly type: KeyType;
  readonly createdAt: string;
  readonly availability?: KeyAvailability;
  /** What a generic credential is for. */
  readonly description?: string;
  /** When a generic credential's value was last saved. */
  readonly updatedAt?: string;
  /** Present while a deleted generic credential is still being removed from apps. */
  readonly status?: KeyStatus;
  /**
   * Whether the caller added this generic credential, which lets them replace its value and attach
   * it to their apps. Other accounts in the installation see only its metadata.
   */
  readonly owned?: boolean;
}

/** A new named secret; ownership always comes from the authenticated session. */
export interface CreateKeyInput {
  readonly name: string;
  readonly type: KeyType;
  readonly material: string;
  /** Only generic credentials keep a description. */
  readonly description?: string;
}

/** Rename a key, or change a generic credential's description, without retrieving its secret. */
export interface RenameKeyInput {
  readonly name: string;
  readonly description?: string;
}

/** Replace a generic credential's value; the old value can't be read or restored afterwards. */
export interface ReplaceKeyValueInput {
  readonly material: string;
}

/** Metadata returned by the key directory. */
export interface KeyList {
  readonly keys: SavedKey[];
}
