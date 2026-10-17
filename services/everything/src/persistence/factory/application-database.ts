import { KeyEntity } from "../../key/schema/key-entity.js";
import { Keys1792713600000 } from "../migration/1792713600000-keys.js";
import { SessionEntity } from "../../session/schema/session-entity.js";
import { BrowserSessions1791763200000 } from "../migration/1791763200000-browser-sessions.js";
import { AgentAvatars1791849600000 } from "../migration/1791849600000-agent-avatars.js";
import { DataSource } from "typeorm";
import { AgentInference1792022400000 } from "../migration/1792022400000-agent-inference.js";
import { ProviderChecks1792108800000 } from "../migration/1792108800000-provider-checks.js";
import { ProviderEntity } from "../../provider/schema/provider-entity.js";
import { ProviderConnections1791936000000 } from "../migration/1791936000000-provider-connections.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import { MessageEntity } from "../../conversation/schema/message-entity.js";
import { InitialSchema1791676800000 } from "../migration/1791676800000-initial-schema.js";
import { WorkspaceInteractionEntity } from "../../workspace/schema/workspace-interaction-entity.js";
import { WorkspaceInteractions1792195200000 } from "../migration/1792195200000-workspace-interactions.js";
import { Updates1792281600000 } from "../migration/1792281600000-updates.js";
import { UpdateEntity } from "../../update/schema/update-entity.js";
import { GeneralSettingsEntity } from "../../settings/schema/general-settings-entity.js";
import { GeneralSettings1792368000000 } from "../migration/1792368000000-general-settings.js";
import { GeneralSettingsSummaryDefault1792454400000 } from "../migration/1792454400000-general-settings-summary-default.js";
import { AgentInteractions1792540800000 } from "../migration/1792540800000-agent-interactions.js";
import { UpdateHistory1792627200000 } from "../migration/1792627200000-update-history.js";

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
    entities: [
      KeyEntity,
      AgentEntity,
      MessageEntity,
      UpdateEntity,
      SessionEntity,
      ProviderEntity,
      WorkspaceInteractionEntity,
      GeneralSettingsEntity,
    ],
    migrations: [
      InitialSchema1791676800000,
      BrowserSessions1791763200000,
      AgentAvatars1791849600000,
      ProviderConnections1791936000000,
      AgentInference1792022400000,
      ProviderChecks1792108800000,
      WorkspaceInteractions1792195200000,
      Updates1792281600000,
      GeneralSettings1792368000000,
      GeneralSettingsSummaryDefault1792454400000,
      AgentInteractions1792540800000,
      UpdateHistory1792627200000,
      Keys1792713600000,
    ],
    migrationsTableName: "everything_migrations",
    migrationsTransactionMode: "all",
    synchronize: false,
    dropSchema: false,
    logging: false,
    invalidWhereValuesBehavior: { null: "throw", undefined: "throw" },
  });
}
