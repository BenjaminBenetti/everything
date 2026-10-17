import type {
  CreateKeyInput,
  RenameKeyInput,
  SavedKey,
} from "@everything/key-contracts";
import type { KeyOperations } from "../interface/key-operations.js";
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
  async list(actorId: string): Promise<SavedKey[]> {
    return (await this.keys.list(actorId)).map((key) => this.describe(key));
  }

  /** Make an accepted upload available through the shared socket before reporting its state. */
  async create(actorId: string, input: CreateKeyInput): Promise<SavedKey> {
    const key = await this.keys.create(actorId, input);
    await this.ssh.refresh();
    return this.describe(key);
  }

  /** Renaming metadata never reloads unchanged private key material. */
  async rename(
    actorId: string,
    id: string,
    input: RenameKeyInput,
  ): Promise<SavedKey> {
    return this.describe(await this.keys.rename(actorId, id, input));
  }

  /** Remove from the authoritative store first, then revoke it from all socket consumers. */
  async delete(actorId: string, id: string): Promise<void> {
    await this.keys.delete(actorId, id);
    await this.ssh.refresh();
  }

  /** Return only a nonsecret status, leaving future key types independent of SSH. */
  private describe(key: SavedKey): SavedKey {
    return key.type === "ssh"
      ? { ...key, availability: this.ssh.status(key.id) }
      : key;
  }
}
