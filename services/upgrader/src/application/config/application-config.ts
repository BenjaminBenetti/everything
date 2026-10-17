import envSchema from "env-schema";
import {
  environmentSchema,
  upgradeJobEnvironmentSchema,
  type EnvironmentSettings,
  type UpgradeJobEnvironmentSettings,
} from "../schema/environment-schema.js";

/** The Helm release to upgrade and where its released versions come from. */
export interface ReleaseConfig {
  /** Released versions of the chart, as an `oci://` reference; empty when upgrades are off. */
  readonly chart: string;
  /** Whether the chart registry serves plain HTTP. */
  readonly plainHttp: boolean;
  readonly name: string;
  readonly namespace: string;
  /** The installer's settings file, applied over the new version's production values. */
  readonly settingsFile: string;
}

/** Validated settings consumed by the service's composition root. */
export interface ApplicationConfig {
  readonly port: number;
  readonly release: ReleaseConfig;
  readonly currentVersion: string;
  /** Callers present service account tokens for this audience, from this account. */
  readonly caller: {
    readonly audience: string;
    readonly username: string;
  };
}

/** Validated settings of one upgrade Job. */
export interface UpgradeJobConfig {
  readonly release: ReleaseConfig;
  readonly version: string;
}

/** Validate the service's environment with env-schema. */
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
    release: releaseConfig(settings),
    currentVersion: settings.CURRENT_VERSION,
    caller: {
      audience: settings.TOKEN_AUDIENCE,
      username: `system:serviceaccount:${settings.RELEASE_NAMESPACE}:${settings.CALLER_SERVICE_ACCOUNT}`,
    },
  };
}

/** Validate an upgrade Job's environment, which the service passes on with the version to install. */
export function loadUpgradeJobConfig(
  environment: NodeJS.ProcessEnv,
): UpgradeJobConfig {
  const settings = envSchema<UpgradeJobEnvironmentSettings>({
    schema: upgradeJobEnvironmentSchema,
    env: false,
    data: environment,
  });
  return {
    release: releaseConfig(settings),
    version: settings.UPGRADE_VERSION,
  };
}

/** The release settings both environments share. */
function releaseConfig(
  settings: EnvironmentSettings | UpgradeJobEnvironmentSettings,
): ReleaseConfig {
  return {
    chart: settings.CHART,
    plainHttp: settings.CHART_PLAIN_HTTP,
    name: settings.RELEASE_NAME,
    namespace: settings.RELEASE_NAMESPACE,
    settingsFile: settings.SETTINGS_FILE,
  };
}
