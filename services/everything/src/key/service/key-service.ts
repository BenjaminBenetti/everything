import { randomUUID } from "node:crypto";
import {
  keyLimits,
  type CreateKeyInput,
  type KeyType,
  type RenameKeyInput,
  type ReplaceKeyValueInput,
  type SavedKey,
} from "@everything/key-contracts";
import { isGenericCredentialValue } from "@everything/key-contracts/generic";
import type { SecretCipher } from "@everything/security/session-cipher";
import type { KeyRepository } from "../interface/key-repository.js";
import type { KeyOperations } from "../interface/key-operations.js";
import type { KeyFormat } from "../interface/key-format.js";
import type { KeyActor } from "../model/key-actor.js";
import type { StoredKey } from "../model/stored-key.js";
import {
  AppCredentialAccessError,
  CredentialOwnerOnlyError,
  InvalidCredentialValueError,
  InvalidKeyError,
  KeyNotFoundError,
} from "../error/key-errors.js";

/**
 * Own validation, encryption, metadata projection, and who may change what. Every signed-in
 * account shares the installation's keys; a generic credential's value can be replaced only by the
 * account that added it, and an app's own token can't add, change, or delete generic credentials.
 */
export class KeyService implements KeyOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive scoped persistence, encryption, and an extensible format registry. */
  constructor(
    private readonly repository: Pick<
      KeyRepository,
      | "list"
      | "getById"
      | "create"
      | "rename"
      | "replaceMaterial"
      | "markDeleted"
      | "delete"
    >,
    private readonly cipher: Pick<SecretCipher, "seal">,
    private readonly formats: ReadonlyMap<KeyType, KeyFormat>,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Return a stable newest-first listing without loading secrets into API responses. */
  async list(actor: KeyActor): Promise<SavedKey[]> {
    return (await this.repository.list(scopeOf(actor)))
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      )
      .map((key) => keyMetadata(key, actor));
  }

  /** Encrypt before passing any record to persistence; never keep plaintext in the entity. */
  async create(actor: KeyActor, input: CreateKeyInput): Promise<SavedKey> {
    const material = input.material;
    const generic = input.type === "generic";
    if (generic) {
      if (actor.app) throw new AppCredentialAccessError();
      if (!isGenericCredentialValue(material))
        throw new InvalidCredentialValueError();
    } else if (
      !material.trim() ||
      Buffer.byteLength(material) > keyLimits.materialLength ||
      !this.formats.get(input.type)?.accepts(material)
    )
      throw new InvalidKeyError();
    const createdAt = new Date().toISOString();
    const key: StoredKey = {
      id: randomUUID(),
      ownerId: actor.subject,
      createdAt,
      name: validName(input.name),
      type: input.type,
      encryptedMaterial: await this.cipher.seal(material),
      description: generic ? validDescription(input.description ?? "") : null,
      version: 1,
      updatedAt: createdAt,
      deletedAt: null,
    };
    await this.repository.create(scopeOf(actor), key);
    return keyMetadata(key, actor);
  }

  /** Update only the name and description, preserving the encrypted material and its version. */
  async rename(
    actor: KeyActor,
    id: string,
    input: RenameKeyInput,
  ): Promise<SavedKey> {
    const current = await this.live(actor, id);
    const generic = current.type === "generic";
    if (generic && actor.app) throw new AppCredentialAccessError();
    const key = await this.repository.rename(
      scopeOf(actor),
      id,
      validName(input.name),
      generic && input.description !== undefined
        ? validDescription(input.description)
        : undefined,
    );
    if (!key) throw new KeyNotFoundError();
    return keyMetadata(key, actor);
  }

  /** Encrypt the new value as the next version; the old one can't be read or restored afterwards. */
  async replaceValue(
    actor: KeyActor,
    id: string,
    input: ReplaceKeyValueInput,
  ): Promise<SavedKey> {
    if (actor.app) throw new AppCredentialAccessError();
    const current = await this.live(actor, id);
    if (current.type !== "generic") throw new KeyNotFoundError();
    if (current.ownerId !== actor.subject) throw new CredentialOwnerOnlyError();
    if (!isGenericCredentialValue(input.material))
      throw new InvalidCredentialValueError();
    const key = await this.repository.replaceMaterial(
      scopeOf(actor),
      id,
      await this.cipher.seal(input.material),
    );
    if (!key) throw new KeyNotFoundError();
    return keyMetadata(key, actor);
  }

  /**
   * Let every installation member remove a shared key; missing records are already deleted. A
   * generic credential's value is erased now and its record kept until apps no longer hold it.
   */
  async delete(actor: KeyActor, id: string): Promise<KeyType | undefined> {
    const key = await this.repository.getById(scopeOf(actor), id);
    if (!key) return undefined;
    if (key.type === "generic") {
      if (actor.app) throw new AppCredentialAccessError();
      await this.repository.markDeleted(scopeOf(actor), id);
      return key.type;
    }
    await this.repository.delete(scopeOf(actor), id);
    return key.type;
  }

  // ===========================================
  // Helpers
  // ===========================================

  /** A key that exists and isn't being removed. */
  private async live(actor: KeyActor, id: string): Promise<StoredKey> {
    const key = await this.repository.getById(scopeOf(actor), id);
    if (!key || key.deletedAt) throw new KeyNotFoundError();
    return key;
  }
}

/** The installation scope, attributed to the acting account. */
function scopeOf(actor: KeyActor) {
  return { usage: "installation", actorId: actor.subject } as const;
}

/** Project a strict allowlist so future secret fields cannot leak into public results. */
function keyMetadata(key: StoredKey, actor: KeyActor): SavedKey {
  return {
    id: key.id,
    name: key.name,
    type: key.type,
    createdAt: key.createdAt,
    ...(key.type === "generic"
      ? {
          description: key.description ?? "",
          updatedAt: key.updatedAt,
          owned: key.ownerId === actor.subject,
          ...(key.deletedAt ? { status: "removing" as const } : {}),
        }
      : {}),
  };
}

/** Apply the same name policy to creation and renaming, including non-HTTP callers. */
function validName(name: string): string {
  const value = name.trim();
  if (!value || value.length > keyLimits.nameLength)
    throw new InvalidKeyError();
  return value;
}

/** Keep descriptions short and free of surrounding whitespace. */
function validDescription(description: string): string {
  const value = description.trim();
  if (value.length > keyLimits.descriptionLength) throw new InvalidKeyError();
  return value;
}
