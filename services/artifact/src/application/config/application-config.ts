import path from "node:path";
import envSchema from "env-schema";
import {
  environmentSchema,
  type EnvironmentSettings,
} from "../schema/environment-schema.js";

/** Validated deployment settings consumed by the composition root. */
export interface ApplicationConfig {
  readonly port: number;
  readonly internalPort: number;
  /** Origin of the Everything application, where viewers sign in. */
  readonly publicOrigin: string;
  /** Origin of the artifact host. */
  readonly artifactOrigin: string;
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly audience: string;
  /** Provisioning credentials belong only to this service; apps receive their own clients. */
  readonly appApi: {
    readonly apiUrl: string;
    readonly audience: string;
    readonly adminUrl: string;
    readonly protocolUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
  };
  readonly databaseUrl: string;
  readonly databasePassword: string;
  /** Artifact databases: the database holding their schemas and the host pods reach it at. */
  readonly artifactData: {
    readonly database: string;
    readonly host: string;
    readonly port: number;
  };
  /** Directory holding uploaded file content. */
  readonly contentDirectory: string;
  readonly cluster: {
    readonly artifactNamespace: string;
    readonly buildNamespace: string;
    readonly storageClassName: string;
  };
  readonly registry: {
    readonly url: string;
    readonly username: string;
    readonly password: string;
    readonly pushHost: string;
    readonly pullHost: string;
    readonly pullSecret: string;
    readonly pushSecret: string;
  };
  /** Base URL of the internal API as build pods reach it. */
  readonly buildSourceUrl: string;
  readonly buildkitImage: string;
}

/** Validate deployment settings with env-schema and normalize paths. */
export function loadApplicationConfig(
  environment: NodeJS.ProcessEnv,
): ApplicationConfig {
  const settings = envSchema<EnvironmentSettings>({
    schema: environmentSchema,
    env: false,
    data: environment,
  });
  const [databaseHost, databasePort] =
    settings.ARTIFACT_DATABASE_HOST.split(":");
  return {
    port: settings.PORT,
    internalPort: settings.INTERNAL_PORT,
    publicOrigin: settings.PUBLIC_ORIGIN,
    artifactOrigin: settings.ARTIFACT_ORIGIN,
    issuer: settings.OIDC_ISSUER,
    jwksUrl: settings.OIDC_JWKS_URL,
    audience: settings.OIDC_AUDIENCE,
    appApi: {
      apiUrl: settings.EVERYTHING_API_URL,
      audience: settings.EVERYTHING_API_AUDIENCE,
      adminUrl: settings.KEYCLOAK_ADMIN_URL,
      protocolUrl: settings.KEYCLOAK_PROTOCOL_URL,
      clientId: settings.APP_PROVISIONER_CLIENT_ID,
      clientSecret: settings.APP_PROVISIONER_CLIENT_SECRET,
    },
    databaseUrl: settings.DATABASE_URL,
    databasePassword: settings.DATABASE_PASSWORD,
    artifactData: {
      database: settings.ARTIFACT_DATA_DATABASE,
      host: databaseHost!,
      port: Number(databasePort ?? "5432"),
    },
    contentDirectory: path.resolve(settings.CONTENT_DIRECTORY),
    cluster: {
      artifactNamespace: settings.ARTIFACT_NAMESPACE,
      buildNamespace: settings.BUILD_NAMESPACE,
      storageClassName: settings.ARTIFACT_STORAGE_CLASS,
    },
    registry: {
      url: settings.REGISTRY_URL,
      username: settings.REGISTRY_USERNAME,
      password: settings.REGISTRY_PASSWORD,
      pushHost: settings.REGISTRY_PUSH_HOST,
      pullHost: settings.REGISTRY_PULL_HOST,
      pullSecret: settings.REGISTRY_PULL_SECRET,
      pushSecret: settings.REGISTRY_PUSH_SECRET,
    },
    buildSourceUrl: settings.BUILD_SOURCE_URL,
    buildkitImage: settings.BUILDKIT_IMAGE,
  };
}
