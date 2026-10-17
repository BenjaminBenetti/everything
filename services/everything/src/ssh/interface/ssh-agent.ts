/** A private key kept in memory only while it is being loaded into OpenSSH. */
export interface SshIdentity {
  readonly id: string;
  readonly material: string;
}

/** A safe per-key result that contains neither key contents nor command diagnostics. */
export interface SshIdentityResult {
  readonly id: string;
  readonly loaded: boolean;
}

/** A managed SSH authentication socket, independent of its operating-system implementation. */
export interface SshAgent {
  readonly socketPath: string;
  /** Start or recover the authentication process at its stable socket path. */
  start(): Promise<void>;
  /** Return a digest of the agent's current public identities to detect drift. */
  inventory(): Promise<string>;
  /** Replace the managed identities without writing private keys to files. */
  replace(
    identities: readonly SshIdentity[],
  ): Promise<readonly SshIdentityResult[]>;
  /** Stop the process and release its socket. */
  close(): Promise<void>;
}
