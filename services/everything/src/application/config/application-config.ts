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
  readonly jwksUrl: string;
  readonly databaseUrl: string;
  readonly databasePassword: string;
  /** Directory holding Pi's provider credentials and model catalog. */
  readonly stateDirectory: string;
  /** Directory holding one subdirectory of files per agent. */
  readonly agentsDirectory: string;
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
    databaseUrl: settings.DATABASE_URL,
    databasePassword: settings.DATABASE_PASSWORD,
    stateDirectory: settings.PI_STATE_DIRECTORY,
    agentsDirectory: path.resolve(settings.AGENTS_DIRECTORY),
  };
}
