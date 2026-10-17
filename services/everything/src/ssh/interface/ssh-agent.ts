/** A managed SSH authentication socket, independent of its operating-system implementation. */
export interface SshAgent {
  readonly socketPath: string;
  /** Start the authentication process, or recover one that exited, at its stable socket path. */
  start(): Promise<void>;
  /** Replace the process with a fresh, empty one at the same path, such as after it was locked. */
  restart(): Promise<void>;
  /** Return the base64 wire-format public keys the agent currently offers. */
  identities(): Promise<ReadonlySet<string>>;
  /**
   * Load one private key without writing it to a file, leaving other identities in place. Return
   * its base64 public key once the agent offers it, or undefined for material the agent cannot use.
   */
  add(material: string): Promise<string | undefined>;
  /** Remove one identity by its base64 public key, leaving other identities in place. */
  remove(publicKey: string): Promise<void>;
  /** Stop the process and release its socket. */
  close(): Promise<void>;
}
