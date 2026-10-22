import AsyncLock from "async-lock";
import type {
  CredentialDelivery,
  CredentialInventoryEntry,
  CredentialRollout,
} from "@everything/artifact-contracts/credential";
import type { SecretCipher } from "@everything/security/session-cipher";
import { ArtifactRequestFailure } from "../../artifact/error/artifact-errors.js";
import type { GenericCredentialRepository } from "../../key/interface/generic-credential-repository.js";
import type { KeyActor } from "../../key/model/key-actor.js";
import type { StoredKey } from "../../key/model/stored-key.js";
import { CredentialUnavailableError } from "../error/credential-errors.js";
import type { CredentialGateway } from "../interface/credential-gateway.js";
import { usageFor } from "../model/credential-usage.js";

/**
 * Bring apps in line with stored generic credentials: deliver a replaced value, revoke a deleted
 * credential, and, in the background, retry both until the app service confirms them. Durable
 * state lives in PostgreSQL: a value's version and a deleted credential's record, kept until no
 * app holds it. Each credential's work runs one at a time in this single Everything replica.
 */
export class CredentialRollouts {
  // ===========================================
  // Construction and state
  // ===========================================

  private readonly lock = new AsyncLock();

  /** Inject credential storage, decryption, the app service, and safe failure reporting. */
  constructor(
    private readonly credentials: Pick<
      GenericCredentialRepository,
      "getById" | "list" | "purge" | "advanceVersion"
    >,
    private readonly cipher: Pick<SecretCipher, "open">,
    private readonly gateway: Pick<
      CredentialGateway,
      "deliverCredential" | "revokeCredential" | "credentialInventory"
    >,
    private readonly reportFailure: (task: string) => void,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Deliver the credential's current value to every app that has it. An unreachable app service
   * reports no usage rather than success; background synchronization keeps trying.
   */
  async deliver(actor: KeyActor, id: string): Promise<CredentialRollout> {
    try {
      const delivery = await this.lock.acquire(id, () =>
        this.deliverOrAlign(id),
      );
      if (!delivery)
        return { complete: true, usage: { apps: [], otherApps: 0 } };
      const saved = await this.credentials.getById(
        { usage: "credential-sync" },
        id,
      );
      return {
        complete: delivery.complete,
        usage: usageFor(
          actor.subject,
          delivery.apps,
          saved && !saved.deletedAt ? saved : undefined,
        ),
      };
    } catch (error) {
      if (error instanceof CredentialUnavailableError) throw error;
      this.reportFailure("delivery");
      return { complete: false, usage: null };
    }
  }

  /**
   * Make apps hold the stored value when they hold a different one at the same or a newer version,
   * for example after Everything's database was restored: save the value past their version, then
   * deliver it. Grants of a credential call this before retrying once.
   */
  async align(id: string): Promise<void> {
    await this.lock.acquire(id, async () => {
      if (await this.realign(id)) await this.deliverCurrent(id);
    });
  }

  /**
   * Revoke a deleted credential from every app, and forget it once no app has a grant and no
   * process holds it. Until then its record stays, so the revocation is retried.
   */
  async revoke(actor: KeyActor, id: string): Promise<CredentialRollout> {
    try {
      const delivery = await this.lock.acquire(id, () =>
        this.revokeAndForget(id),
      );
      return {
        complete: delivery.complete,
        usage: usageFor(actor.subject, delivery.apps),
      };
    } catch {
      this.reportFailure("revocation");
      return { complete: false, usage: null };
    }
  }

  /**
   * Compare stored credentials with the app service's inventory: retry revocations of deleted
   * credentials, deliver values apps are missing or have older versions of, and revoke credentials
   * that apps hold but Everything no longer stores.
   */
  async synchronize(): Promise<void> {
    const inventory = await this.gateway.credentialInventory();
    const credentials = await this.credentials.list({
      usage: "credential-sync",
    });
    for (const credential of credentials) {
      if (credential.deletedAt) {
        await this.quietly("revocation", () =>
          this.lock.acquire(credential.id, () =>
            this.revokeAndForget(credential.id),
          ),
        );
        continue;
      }
      const entry = inventory.find(
        (candidate) => candidate.credentialId === credential.id,
      );
      if (!entry || entry.oldestVersion === null) continue;
      if (
        diverged(entry, credential) ||
        entry.oldestVersion < credential.version ||
        entry.missing
      )
        await this.quietly("delivery", () =>
          this.lock.acquire(credential.id, () =>
            this.deliverOrAlign(credential.id),
          ),
        );
    }
    const stored = new Set(credentials.map((credential) => credential.id));
    for (const entry of inventory)
      if (
        !stored.has(entry.credentialId) &&
        (entry.oldestVersion !== null || entry.held || !entry.revoked)
      )
        await this.quietly("revocation", () =>
          this.lock.acquire(entry.credentialId, () =>
            this.gateway.revokeCredential(entry.credentialId),
          ),
        );
  }

  // ===========================================
  // Steps
  // ===========================================

  /**
   * Deliver the stored value; when apps already hold another value at that version or a newer
   * one, save the value past their version and deliver it once more.
   */
  private async deliverOrAlign(
    id: string,
  ): Promise<CredentialDelivery | undefined> {
    try {
      return await this.deliverCurrent(id);
    } catch (error) {
      if (
        !(error instanceof ArtifactRequestFailure) ||
        (error.code !== "CREDENTIAL_VALUE_CONFLICT" &&
          error.code !== "CREDENTIAL_SUPERSEDED")
      )
        throw error;
      if (!(await this.realign(id))) throw error;
      return this.deliverCurrent(id);
    }
  }

  /**
   * Compare the stored version and value with the newest the app service recorded; if apps hold a
   * newer version or another value at this one, save the stored value one version past theirs.
   * Returns whether it moved the version.
   */
  private async realign(id: string): Promise<boolean> {
    const credential = await this.credentials.getById(
      { usage: "credential-sync" },
      id,
    );
    if (!credential || credential.deletedAt || !credential.valueId)
      return false;
    const entry = (await this.gateway.credentialInventory()).find(
      (candidate) => candidate.credentialId === id,
    );
    if (!entry || !diverged(entry, credential)) return false;
    return this.credentials.advanceVersion(
      id,
      { version: credential.version, valueId: credential.valueId },
      entry.version! + 1,
    );
  }

  /** Send the stored version and value; a credential deleted meanwhile is left to revocation. */
  private async deliverCurrent(
    id: string,
  ): Promise<CredentialDelivery | undefined> {
    const credential = await this.credentials.getById(
      { usage: "credential-sync" },
      id,
    );
    if (!credential || credential.deletedAt || !credential.valueId)
      return undefined;
    let value: string;
    try {
      value = await this.cipher.open(credential.encryptedMaterial);
    } catch {
      throw new CredentialUnavailableError();
    }
    return this.gateway.deliverCredential(id, {
      version: credential.version,
      valueId: credential.valueId,
      value,
    });
  }

  /** Revoke, then delete the record only when the app service reports nothing left to remove. */
  private async revokeAndForget(id: string): Promise<CredentialDelivery> {
    const delivery = await this.gateway.revokeCredential(id);
    if (delivery.complete) await this.credentials.purge(id);
    return delivery;
  }

  /** Run background work for one credential, reporting a failure without its details. */
  private async quietly(
    task: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await work();
    } catch {
      this.reportFailure(task);
    }
  }
}

/**
 * Whether apps hold a value the stored one can't follow by version alone: a newer version, or
 * another value at the same version, as after Everything's database was restored.
 */
function diverged(
  entry: CredentialInventoryEntry,
  credential: Pick<StoredKey, "version" | "valueId">,
): boolean {
  return (
    entry.version !== null &&
    (entry.version > credential.version ||
      (entry.version === credential.version &&
        entry.valueId !== null &&
        entry.valueId !== credential.valueId))
  );
}
