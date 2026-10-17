import { createHash } from "node:crypto";
import type { SecretCipher } from "@everything/security/session-cipher";
import type { SshAgent } from "../interface/ssh-agent.js";
import type {
  EncryptedSshIdentity,
  SshKeySource,
  SshKeyStatus,
  SshKeySynchronization,
} from "../interface/ssh-key-source.js";

/** What Everything loaded for one saved key: its ciphertext's digest and the public key it offers. */
interface LoadedKey {
  readonly digest: string;
  readonly publicKey: string | undefined;
}

/**
 * Keep one SSH agent's managed identities aligned with an authorized encrypted snapshot, key by key:
 * new keys are added and deleted ones removed while every other identity stays loaded. A dead
 * agent is started again, and a locked or unresponsive one is replaced and reloaded.
 */
export class SshKeySynchronizer implements SshKeySynchronization {
  // ===========================================
  // Construction and state
  // ===========================================

  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private requested = 0;
  private readonly loaded = new Map<string, LoadedKey>();
  private statuses = new Map<string, SshKeyStatus>();

  /** Receive only the selected pool, decryption, an authentication socket, and safe operational reporting. */
  constructor(
    private readonly source: SshKeySource,
    private readonly cipher: Pick<SecretCipher, "open">,
    private readonly agent: SshAgent,
    private readonly reportFailure: () => void,
  ) {}

  // ===========================================
  // Lifecycle and observation
  // ===========================================

  /** Establish the socket before consumers start, then recover drift and process exits every five seconds. */
  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    await this.agent.start();
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.timer.unref();
  }

  /** Drain synchronization before stopping the private-key holder or closing its database. */
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
    await this.agent.close();
    this.statuses.clear();
  }

  /** Expose only readiness, never secret contents, subprocess output, or host information. */
  status(id: string): SshKeyStatus {
    return this.statuses.get(id) ?? "pending";
  }

  /** A mutation during a pass forces a later snapshot before that mutation's refresh resolves. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.requested++;
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  // ===========================================
  // Convergence
  // ===========================================

  /** Serialize passes, catching operational failures without recording secrets. */
  private async drain(): Promise<void> {
    let observed: number;
    do {
      observed = this.requested;
      await this.pass();
    } while (!this.stopped && this.requested !== observed);
  }

  /**
   * Read a fresh snapshot and converge the agent on it. A failed read leaves the agent's identities
   * as they are; a failing agent is replaced once, which also revokes every deleted key.
   */
  private async pass(): Promise<void> {
    let records: EncryptedSshIdentity[];
    try {
      records = [...(await this.source.read())].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
    } catch {
      this.statuses.clear();
      this.reportFailure();
      return;
    }
    try {
      await this.converge(records);
    } catch {
      try {
        this.loaded.clear();
        if (this.stopped) return;
        await this.agent.restart();
        await this.converge(records);
      } catch {
        // Until a successful pass verifies the socket, previously reported readiness is unknown.
        this.loaded.clear();
        this.statuses.clear();
        this.reportFailure();
      }
    }
  }

  /**
   * Remove identities of deleted or changed keys that no remaining key shares, then load keys the
   * agent does not offer. A refused removal, or a key that loaded before but is refused now, means
   * the agent is locked or broken, which throws so the agent is replaced.
   */
  private async converge(
    records: readonly EncryptedSshIdentity[],
  ): Promise<void> {
    await this.agent.start();
    const offered = new Set(await this.agent.identities());
    const wanted = new Map(
      records.map((record) => [record.id, digest(record.encryptedMaterial)]),
    );
    for (const [id, key] of this.loaded) {
      if (wanted.get(id) === key.digest) continue;
      this.loaded.delete(id);
      if (!key.publicKey || this.shares(key.publicKey)) continue;
      // Removed even when not offered: a locked agent hides its keys and refuses the removal, which
      // replaces it, so a deleted key never survives to be unlocked later.
      await this.agent.remove(key.publicKey);
      offered.delete(key.publicKey);
    }
    const statuses = new Map<string, SshKeyStatus>();
    for (const record of records) {
      if (this.stopped) return;
      const keyDigest = wanted.get(record.id)!;
      const previous = this.loaded.get(record.id);
      const known = previous?.digest === keyDigest ? previous : undefined;
      if (known && (!known.publicKey || offered.has(known.publicKey))) {
        statuses.set(record.id, known.publicKey ? "ready" : "unavailable");
        continue;
      }
      let material: string;
      try {
        material = await this.cipher.open(record.encryptedMaterial);
      } catch {
        this.loaded.set(record.id, { digest: keyDigest, publicKey: undefined });
        statuses.set(record.id, "unavailable");
        continue;
      }
      const publicKey = await this.agent.add(material);
      if (!publicKey && known?.publicKey)
        throw new Error("SSH agent refused a key it held before");
      this.loaded.set(record.id, { digest: keyDigest, publicKey });
      if (publicKey) offered.add(publicKey);
      statuses.set(record.id, publicKey ? "ready" : "unavailable");
    }
    this.statuses = statuses;
  }

  /** Whether a still-wanted key offers the same public key, such as a second upload of one file. */
  private shares(publicKey: string): boolean {
    for (const key of this.loaded.values())
      if (key.publicKey === publicKey) return true;
    return false;
  }
}

/** Identify a record's ciphertext without decrypting it, so changed material is reloaded. */
function digest(encryptedMaterial: string): string {
  return createHash("sha256").update(encryptedMaterial).digest("hex");
}
