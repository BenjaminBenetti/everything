/** How an artifact's pod reaches its own database. */
export interface DatabaseConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

/** Provisions each dynamic artifact's own PostgreSQL role and schema. */
export interface ArtifactDatabases {
  /** Create the role and schema if they are missing, set the role's password, and describe the connection. */
  ensure(artifactId: string, password: string): Promise<DatabaseConnection>;
  /** Drop the role and schema with all of their data; a missing role is ignored. */
  remove(artifactId: string): Promise<void>;
}
