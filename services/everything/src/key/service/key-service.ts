import { randomUUID } from "node:crypto";
import {
  keyLimits,
  type CreateKeyInput,
  type KeyType,
  type RenameKeyInput,
  type SavedKey,
} from "@everything/key-contracts";
import type { SecretCipher } from "@everything/security/session-cipher";
import type { KeyRepository } from "../interface/key-repository.js";
import type { KeyOperations } from "../interface/key-operations.js";
import type { KeyFormat } from "../interface/key-format.js";
import type { StoredKey } from "../model/stored-key.js";
import { InvalidKeyError, KeyNotFoundError } from "../error/key-errors.js";

/** Own validation, encryption, and metadata projection independently of key formats. */
export class KeyService implements KeyOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive scoped persistence, encryption, and an extensible format registry. */
  constructor(
    private readonly repository: Pick<
      KeyRepository,
      "list" | "create" | "rename" | "delete"
    >,
    private readonly cipher: Pick<SecretCipher, "seal">,
    private readonly formats: ReadonlyMap<KeyType, KeyFormat>,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Return a stable newest-first listing without loading secrets into API responses. */
  async list(actorId: string): Promise<SavedKey[]> {
    return (await this.repository.list({ usage: "installation", actorId }))
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      )
      .map(keyMetadata);
  }

  /** Encrypt before passing any record to persistence; never keep plaintext in the entity. */
  async create(actorId: string, input: CreateKeyInput): Promise<SavedKey> {
    const material = input.material;
    if (
      !material.trim() ||
      Buffer.byteLength(material) > keyLimits.materialLength ||
      !this.formats.get(input.type)?.accepts(material)
    )
      throw new InvalidKeyError();
    const key: StoredKey = {
      id: randomUUID(),
      ownerId: actorId,
      createdAt: new Date().toISOString(),
      name: validName(input.name),
      type: input.type,
      encryptedMaterial: await this.cipher.seal(material),
    };
    await this.repository.create({ usage: "installation", actorId }, key);
    return keyMetadata(key);
  }

  /** Update only the name, preserving the encrypted material and original creation time. */
  async rename(
    actorId: string,
    id: string,
    input: RenameKeyInput,
  ): Promise<SavedKey> {
    const key = await this.repository.rename(
      { usage: "installation", actorId },
      id,
      validName(input.name),
    );
    if (!key) throw new KeyNotFoundError();
    return keyMetadata(key);
  }

  /** Let every installation member remove a shared key; missing records are already deleted. */
  delete(actorId: string, id: string): Promise<void> {
    return this.repository.delete({ usage: "installation", actorId }, id);
  }
}

/** Project a strict allowlist so future secret fields cannot leak into public results. */
function keyMetadata(key: StoredKey): SavedKey {
  return {
    id: key.id,
    name: key.name,
    type: key.type,
    createdAt: key.createdAt,
  };
}

/** Apply the same name policy to creation and renaming, including non-HTTP callers. */
function validName(name: string): string {
  const value = name.trim();
  if (!value || value.length > keyLimits.nameLength)
    throw new InvalidKeyError();
  return value;
}
