/** A stored copy of one credential version for one app, identified without reading its value. */
export interface StoredCredentialSecret {
  readonly artifactId: string;
  readonly credentialId: string;
  readonly version: number;
  /** Identity of the stored value, from the Secret's label; null for copies made before identities. */
  readonly valueId: string | null;
  readonly name: string;
}

/**
 * Where values granted to apps are kept for their processes: one immutable runtime Secret per app,
 * credential, and version. This is the only place the app service keeps a value.
 */
export interface CredentialSecrets {
  /**
   * Store one version's value for an app. An existing copy of another value with the same version
   * is refused; a copy whose bytes were changed by hand is restored.
   */
  write(
    artifactId: string,
    credentialId: string,
    version: number,
    valueId: string,
    value: string,
  ): Promise<void>;
  /** List stored copies, of one app or of every app. */
  stored(artifactId?: string): Promise<StoredCredentialSecret[]>;
  /** Delete an app's stored copies except the named ones. */
  prune(artifactId: string, keep: ReadonlySet<string>): Promise<void>;
  /** Read one stored value, or undefined when the copy is absent. */
  read(name: string): Promise<string | undefined>;
}
