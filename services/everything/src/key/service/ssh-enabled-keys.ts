import type {
  CreateKeyInput,
  KeyType,
  RenameKeyInput,
  ReplaceKeyValueInput,
  SavedKey,
} from "@everything/key-contracts";
import type { KeyOperations } from "../interface/key-operations.js";
import type { KeyActor } from "../model/key-actor.js";
import type { SshKeySynchronization } from "../../ssh/interface/ssh-key-source.js";

/** Add SSH convergence and safe availability metadata to the generic key-management use cases. */
export class SshEnabledKeys implements KeyOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Keep credential storage independent of the optional runtime integration. */
  constructor(
    private readonly keys: KeyOperations,
    private readonly ssh: SshKeySynchronization,
  ) {}

  // ===========================================
  // Key management
  // ===========================================

  /** Preserve the shared directory while annotating only SSH keys with runtime state. */
  async list(actor: KeyActor): Promise<SavedKey[]> {
    return (await this.keys.list(actor)).map((key) => this.describe(key));
  }

  /** Make an accepted upload available through the shared socket before reporting its state. */
  async create(actor: KeyActor, input: CreateKeyInput): Promise<SavedKey> {
    const key = await this.keys.create(actor, input);
    if (key.type === "ssh") await this.ssh.refresh();
    return this.describe(key);
  }

  /** Renaming metadata never reloads unchanged private key material. */
  async rename(
    actor: KeyActor,
    id: string,
    input: RenameKeyInput,
  ): Promise<SavedKey> {
    return this.describe(await this.keys.rename(actor, id, input));
  }

  /** Generic credential values never reach the SSH agent. */
  replaceValue(
    actor: KeyActor,
    id: string,
    input: ReplaceKeyValueInput,
  ): Promise<SavedKey> {
    return this.keys.replaceValue(actor, id, input);
  }

  /** Remove from the authoritative store first, then revoke it from all socket consumers. */
  async delete(actor: KeyActor, id: string): Promise<KeyType | undefined> {
    const type = await this.keys.delete(actor, id);
    if (type !== "generic") await this.ssh.refresh();
    return type;
  }

  /** Return only a nonsecret status, leaving future key types independent of SSH. */
  private describe(key: SavedKey): SavedKey {
    return key.type === "ssh"
      ? { ...key, availability: this.ssh.status(key.id) }
      : key;
  }
}
