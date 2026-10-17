import { createHash } from "node:crypto";
import type { SecretCipher } from "@everything/security/session-cipher";
import type { SshAgent, SshIdentity } from "../interface/ssh-agent.js";
import type {
  SshKeySource,
  SshKeyStatus,
  SshKeySynchronization,
} from "../interface/ssh-key-source.js";

/** Keep one SSH-agent socket aligned with an authorized encrypted snapshot across failures and restarts. */
export class SshKeySynchronizer implements SshKeySynchronization {
  // ===========================================
  // Construction and state
  // ===========================================

  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private requested = 0;
  private snapshot: string | undefined;
  private inventory: string | undefined;
  private readonly statuses = new Map<string, SshKeyStatus>();

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

  /** Serialize reads and socket changes, catching operational failures without recording secrets. */
  private async drain(): Promise<void> {
    let observed: number;
    do {
      observed = this.requested;
      try {
        await this.reconcile();
      } catch {
        // Until a successful pass verifies the socket, previously reported readiness is unknown.
        this.statuses.clear();
        this.snapshot = undefined;
        this.reportFailure();
      }
    } while (!this.stopped && this.requested !== observed);
  }

  /** Clear stale identities only after a successful source read, and load each decryptable key independently. */
  private async reconcile(): Promise<void> {
    const records = [...(await this.source.read())].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const snapshot = createHash("sha256")
      .update(JSON.stringify(records))
      .digest("hex");
    await this.agent.start();
    const inventory = await this.agent.inventory();
    if (snapshot === this.snapshot && inventory === this.inventory) return;
    const identities: SshIdentity[] = [];
    const statuses = new Map<string, SshKeyStatus>();
    for (const record of records) {
      try {
        identities.push({
          id: record.id,
          material: await this.cipher.open(record.encryptedMaterial),
        });
      } catch {
        statuses.set(record.id, "unavailable");
      }
    }
    if (this.stopped) return;
    for (const result of await this.agent.replace(identities))
      statuses.set(result.id, result.loaded ? "ready" : "unavailable");
    this.inventory = await this.agent.inventory();
    this.snapshot = snapshot;
    this.statuses.clear();
    for (const [id, status] of statuses) this.statuses.set(id, status);
  }
}
