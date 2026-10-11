import { SessionEntity } from "../../session/schema/session-entity.js";
import { BrowserSessions1791763200000 } from "../migration/1791763200000-browser-sessions.js";
import { DataSource } from "typeorm";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import { MessageEntity } from "../../conversation/schema/message-entity.js";
import { InitialSchema1791676800000 } from "../migration/1791676800000-initial-schema.js";

/** Connection settings for the service's own PostgreSQL database. */
export interface DatabaseConnectionSettings {
  /** `postgresql://user@host:port/database`; the password is supplied separately. */
  readonly databaseUrl: string;
  readonly databasePassword: string;
}

/** Configure the ORM and explicit migrations without automatic schema mutation. */
export function createApplicationDatabase(
  settings: DatabaseConnectionSettings,
): DataSource {
  const address = new URL(settings.databaseUrl);
  return new DataSource({
    type: "postgres",
    host: address.hostname,
    port: Number(address.port || "5432"),
    database: address.pathname.slice(1),
    username: decodeURIComponent(address.username),
    password: settings.databasePassword,
    poolSize: 5,
    extra: { connectionTimeoutMillis: 5000 },
    entities: [AgentEntity, MessageEntity, SessionEntity],
    migrations: [InitialSchema1791676800000, BrowserSessions1791763200000],
    migrationsTableName: "everything_migrations",
    migrationsTransactionMode: "all",
    synchronize: false,
    dropSchema: false,
    logging: false,
    invalidWhereValuesBehavior: { null: "throw", undefined: "throw" },
  });
}
