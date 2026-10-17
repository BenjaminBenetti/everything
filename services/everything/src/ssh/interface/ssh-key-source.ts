/** A secret-bearing projection used only inside the server's synchronization boundary. */
export interface EncryptedSshIdentity {
  readonly id: string;
  readonly encryptedMaterial: string;
}

/** A composition-scoped source; implementations choose and enforce the authorized key pool. */
export interface SshKeySource {
  /** Read a fresh encrypted snapshot; failure must never be represented as an empty snapshot. */
  read(): Promise<readonly EncryptedSshIdentity[]>;
}

/** Nonsecret availability for a stored key, without exposing its public or private material. */
export type SshKeyStatus = "pending" | "ready" | "unavailable";

/** The key domain can request convergence and inspect availability without controlling the daemon. */
export interface SshKeySynchronization {
  /** Reconcile a fresh snapshot, including mutations arriving during an existing pass. */
  refresh(): Promise<void>;
  /** Return pending until the current key has been processed. */
  status(id: string): SshKeyStatus;
}
