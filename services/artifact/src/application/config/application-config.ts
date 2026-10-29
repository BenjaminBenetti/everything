import path from "node:path";
import envSchema from "env-schema";
import { cookieHost, hostCookieHost } from "@everything/security/cookie-host";
import {
  environmentSchema,
  type EnvironmentSettings,
} from "../schema/environment-schema.js";

/** Validated deployment settings consumed by the composition root. */
export interface ApplicationConfig {
  readonly port: number;
  readonly internalPort: number;
  /** Port serving the public apps host, on its own origin. */
  readonly publicAppsPort: number;
  /** Origin of the Everything application, where viewers sign in. */
  readonly publicOrigin: string;
  /** Origin of the artifact host, where owners, teammates, and API keys open apps. */
  readonly artifactOrigin: string;
  /** Origin that serves public apps to anyone, isolated from the artifact host. */
  readonly publicAppsOrigin: string;
  /**
   * The cookie hosts each viewer host serves requests for, its origin's first, then those pods inside
   * the cluster use. The two share none, and the public apps host's exclude the application's.
   */
  readonly viewerHostnames: {
    readonly artifact: readonly string[];
    readonly publicApps: readonly string[];
  };
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
  const viewerHostnames = {
    artifact: hostnamesOf(
      settings.ARTIFACT_ORIGIN,
      settings.ARTIFACT_INTERNAL_HOSTNAMES,
    ),
    publicApps: hostnamesOf(
      settings.PUBLIC_APPS_ORIGIN,
      settings.PUBLIC_APPS_INTERNAL_HOSTNAMES,
    ),
  };
  // Public apps are isolated only on hostnames of their own, apart from the app host's and
  // Everything's: browsers send a hostname's cookies to every port, so a different port alone would
  // hand private apps' and Everything's cookies to public apps, and let private apps set theirs where
  // public apps receive them. The artifact host may share Everything's, as it does locally.
  const taken = [
    cookieHost(settings.PUBLIC_ORIGIN),
    ...viewerHostnames.artifact,
  ];
  if (viewerHostnames.publicApps.some((hostname) => taken.includes(hostname)))
    throw new Error(
      "PUBLIC_APPS_ORIGIN and PUBLIC_APPS_INTERNAL_HOSTNAMES need hostnames apart from ARTIFACT_ORIGIN's, ARTIFACT_INTERNAL_HOSTNAMES, and PUBLIC_ORIGIN's, since browsers share cookies across ports",
    );
  const [databaseHost, databasePort] =
    settings.ARTIFACT_DATABASE_HOST.split(":");
  return {
    port: settings.PORT,
    internalPort: settings.INTERNAL_PORT,
    publicAppsPort: settings.PUBLIC_APPS_PORT,
    publicOrigin: settings.PUBLIC_ORIGIN,
    artifactOrigin: settings.ARTIFACT_ORIGIN,
    publicAppsOrigin: settings.PUBLIC_APPS_ORIGIN,
    viewerHostnames,
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

/** A viewer host's cookie hosts: its origin's, then its comma-separated internal hostnames'. */
function hostnamesOf(origin: string, internal: string): string[] {
  const hostnames = internal.split(",").map((hostname) => {
    const host = hostCookieHost(hostname);
    if (!host) throw new Error("Internal hostnames must be hostnames");
    return host;
  });
  return [...new Set([cookieHost(origin), ...hostnames])];
}
