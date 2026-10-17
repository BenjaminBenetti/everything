/** Bounds shared by uploads, request validation, and persistence. */
export const keyLimits = {
  nameLength: 128,
  typeLength: 64,
  materialLength: 32768,
} as const;

/** Extend this catalog as additional key formats become available. */
export const keyTypes = [{ id: "ssh", label: "SSH" }] as const;
export type KeyType = (typeof keyTypes)[number]["id"];

/** Runtime availability is metadata, independent of the stored secret and its format. */
export type KeyAvailability = "pending" | "ready" | "unavailable";

/** Public metadata deliberately excludes both plaintext and encrypted key material. */
export interface SavedKey {
  readonly id: string;
  readonly name: string;
  readonly type: KeyType;
  readonly createdAt: string;
  readonly availability?: KeyAvailability;
}

/** A new named secret; ownership always comes from the authenticated session. */
export interface CreateKeyInput {
  readonly name: string;
  readonly type: KeyType;
  readonly material: string;
}

/** Rename a key without retrieving or replacing its secret. */
export interface RenameKeyInput {
  readonly name: string;
}

/** Metadata returned by the key directory. */
export interface KeyList {
  readonly keys: SavedKey[];
}
