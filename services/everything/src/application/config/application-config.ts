import path from "node:path";
import envSchema from "env-schema";
import {
  environmentSchema,
  type EnvironmentSettings,
} from "../schema/environment-schema.js";

/** Validated deployment settings consumed by the composition root. */
export interface ApplicationConfig {
  readonly port: number;
  readonly issuer: string;
  readonly audience: string;
  readonly publicOrigin: string;
  readonly chatGptRedirectUri: string;
  readonly protocolUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionEncryptionKey: string;
  readonly jwksUrl: string;
  readonly databaseUrl: string;
  readonly databasePassword: string;
  /** Directory holding Pi's provider credentials and model catalog. */
  readonly stateDirectory: string;
  /** Directory holding one subdirectory of files per agent. */
  readonly agentsDirectory: string;
  /** Internal tools pods are reconciled from the chart's reusable StatefulSet template. */
  readonly workspacePods: {
    readonly namespace: string;
    readonly templateName: string;
    readonly claimName: string;
  };
  /**
   * The artifact service's internal API and the client credentials used to call it, and its artifact
   * host as teammate pods reach it inside the cluster.
   */
  readonly artifactService: {
    readonly url: string;
    readonly hostUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
  };
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
  return {
    port: settings.PORT,
    issuer: settings.OIDC_ISSUER,
    jwksUrl: settings.OIDC_JWKS_URL,
    audience: settings.OIDC_AUDIENCE,
    publicOrigin: settings.PUBLIC_ORIGIN,
    chatGptRedirectUri: settings.CHATGPT_REDIRECT_URI,
    protocolUrl: settings.OIDC_PROTOCOL_URL,
    clientId: settings.OIDC_CLIENT_ID,
    clientSecret: settings.OIDC_CLIENT_SECRET,
    sessionEncryptionKey: settings.SESSION_ENCRYPTION_KEY,
    databaseUrl: settings.DATABASE_URL,
    databasePassword: settings.DATABASE_PASSWORD,
    stateDirectory: settings.PI_STATE_DIRECTORY,
    agentsDirectory: path.resolve(settings.AGENTS_DIRECTORY),
    workspacePods: {
      namespace: settings.WORKSPACE_NAMESPACE,
      templateName: settings.WORKSPACE_TEMPLATE_NAME,
      claimName: settings.WORKSPACE_CLAIM_NAME,
    },
    artifactService: {
      url: settings.ARTIFACT_SERVICE_URL,
      hostUrl: settings.ARTIFACT_HOST_URL,
      clientId: settings.ARTIFACT_CLIENT_ID,
      clientSecret: settings.ARTIFACT_CLIENT_SECRET,
    },
  };
}
