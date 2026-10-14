/** The Fleet release Everything runs, pinned in the Helm chart. */
export interface FleetRelease {
  /** Release tag, such as `v3.0.0-beta`. */
  readonly version: string;
  /** Base URL of the release downloads; each file is at `<url>/<version>/<file>`. */
  readonly url: string;
  /** SHA-256 of each release file, by file name. */
  readonly checksums: Readonly<Record<string, string>>;
}

/** The registry Fleet delivers the images it builds through. */
export interface FleetRegistry {
  /** Address images are pushed to and named by, which nodes pull them from. */
  readonly host: string;
  /** Accept the registry's certificate unverified, for a development registry's self-signed one. */
  readonly insecure: boolean;
  readonly username: string;
  readonly password: string;
}

/** Where fleetd runs inside Everything's container and the cluster connection it is given. */
export interface FleetSettings {
  /** Fleet's home directory; fleetd keeps its own state in `.fleet` there. */
  readonly home: string;
  readonly release: FleetRelease;
  /** Namespace of Fleet's instances. */
  readonly namespace: string;
  /** Storage class of instance disks; empty lets Fleet choose one. */
  readonly storageClass: string;
  readonly registry: FleetRegistry;
}
