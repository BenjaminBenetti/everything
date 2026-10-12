import { DataSource } from "typeorm";
import { ArtifactEntity } from "../../artifact/schema/artifact-entity.js";
import { BuildEntity } from "../../image/schema/build-entity.js";
import { DeploymentEntity } from "../../deployment/schema/deployment-entity.js";
import { RevisionEntity } from "../../revision/schema/revision-entity.js";
import {
  ViewGrantEntity,
  ViewSessionEntity,
} from "../../viewing/schema/view-entities.js";
import { Artifacts1792022400000 } from "../migration/1792022400000-artifacts.js";

/** Connection settings for one PostgreSQL database. */
export interface DatabaseConnectionSettings {
  /** `postgresql://user@host:port/database`; the password is supplied separately. */
  readonly databaseUrl: string;
  readonly databasePassword: string;
}

/** Parse a connection URL into TypeORM's connection options. */
export function connectionOptions(settings: DatabaseConnectionSettings) {
  const address = new URL(settings.databaseUrl);
  return {
    type: "postgres" as const,
    host: address.hostname,
    port: Number(address.port || "5432"),
    database: address.pathname.slice(1),
    username: decodeURIComponent(address.username),
    password: settings.databasePassword,
    extra: { connectionTimeoutMillis: 5000 },
  };
}

/** Configure the service's own database with explicit migrations and no automatic schema changes. */
export function createArtifactDatabase(
  settings: DatabaseConnectionSettings,
): DataSource {
  return new DataSource({
    ...connectionOptions(settings),
    poolSize: 5,
    entities: [
      ArtifactEntity,
      RevisionEntity,
      BuildEntity,
      DeploymentEntity,
      ViewGrantEntity,
      ViewSessionEntity,
    ],
    migrations: [Artifacts1792022400000],
    migrationsTableName: "artifact_migrations",
    migrationsTransactionMode: "all",
    synchronize: false,
    dropSchema: false,
    logging: false,
    invalidWhereValuesBehavior: { null: "throw", undefined: "throw" },
  });
}
