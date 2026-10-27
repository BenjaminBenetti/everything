import path from "node:path";
import envSchema from "env-schema";
import { Value } from "typebox/value";
import { sharesCookieHost } from "@everything/security/cookie-host";
import type { FleetSettings } from "../../fleet/model/fleet-settings.js";
import type { VoiceSettings } from "../../voice/model/voice-settings.js";
import type { TelemetrySettings } from "../../telemetry/model/telemetry-settings.js";
import { loadTelemetrySettingsOrUnavailable } from "../../telemetry/config/telemetry-config.js";
import {
  environmentSchema,
  fleetChecksumsSchema,
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
   * host and public apps host as teammate pods reach them inside the cluster.
   */
  readonly artifactService: {
    readonly url: string;
    readonly hostUrl: string;
    readonly publicAppsHostUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
  };
  /** The Fleet release fleetd runs from, its home, its cluster connection, and its registry. */
  readonly fleet: FleetSettings;
  /** The upgrader and the token file proving requests come from Everything; no URL, no upgrades. */
  readonly upgrader: {
    readonly url: string;
    readonly tokenFile: string;
  };
  /** The self-hosted speech recognition service and transcription limits; no service, no voice input. */
  readonly voice: VoiceSettings;
  /** The in-cluster telemetry backend and its retention; no backend, no telemetry. */
  readonly telemetry: TelemetrySettings;
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
  // Teammates' browsers open private apps on the artifact host and public apps on the public apps
  // host; browsers send a hostname's cookies to every port, so they need different hostnames.
  if (
    [settings.ARTIFACT_HOST_URL, settings.PUBLIC_ORIGIN].some((other) =>
      sharesCookieHost(other, settings.ARTIFACT_PUBLIC_APPS_HOST_URL),
    )
  )
    throw new Error(
      "ARTIFACT_PUBLIC_APPS_HOST_URL needs a hostname apart from ARTIFACT_HOST_URL's and PUBLIC_ORIGIN's, since browsers share cookies across ports",
    );
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
      publicAppsHostUrl: settings.ARTIFACT_PUBLIC_APPS_HOST_URL,
      clientId: settings.ARTIFACT_CLIENT_ID,
      clientSecret: settings.ARTIFACT_CLIENT_SECRET,
    },
    upgrader: {
      url: settings.UPGRADER_URL,
      tokenFile: settings.UPGRADER_TOKEN_FILE,
    },
    voice: {
      service: settings.VOICE_ASR_URL
        ? {
            url: serviceUrl("VOICE_ASR_URL", settings.VOICE_ASR_URL, [
              "http:",
              "https:",
            ]),
            token: settings.VOICE_ASR_TOKEN,
            model: settings.VOICE_ASR_MODEL,
            timeoutMs: settings.VOICE_ASR_TIMEOUT_MS,
          }
        : null,
      stream: settings.VOICE_STREAM_URL
        ? {
            url: serviceUrl("VOICE_STREAM_URL", settings.VOICE_STREAM_URL, [
              "ws:",
              "wss:",
            ]),
            token: settings.VOICE_STREAM_TOKEN,
            finalTimeoutMs: settings.VOICE_STREAM_FINAL_TIMEOUT_MS,
            concurrency: settings.VOICE_STREAM_CONCURRENCY,
          }
        : null,
      admission: {
        concurrency: settings.VOICE_CONCURRENCY,
        queueLimit: settings.VOICE_QUEUE_LIMIT,
        queueTimeoutMs: settings.VOICE_QUEUE_TIMEOUT_MS,
      },
    },
    telemetry: loadTelemetrySettingsOrUnavailable(environment),
    fleet: {
      home: path.resolve(settings.FLEET_HOME),
      release: {
        version: settings.FLEET_VERSION,
        url: settings.FLEET_RELEASE_URL,
        checksums: Value.Parse(
          fleetChecksumsSchema,
          JSON.parse(settings.FLEET_CHECKSUMS),
        ),
      },
      namespace: settings.FLEET_NAMESPACE,
      storageClass: settings.FLEET_STORAGE_CLASS,
      registry: {
        host: settings.FLEET_REGISTRY,
        insecure: settings.FLEET_REGISTRY_INSECURE,
        username: settings.REGISTRY_USERNAME,
        password: settings.REGISTRY_PASSWORD,
      },
      ...(settings.FLEET_GATEWAY_URL
        ? { remote: { gatewayUrl: settings.FLEET_GATEWAY_URL } }
        : {}),
    },
  };
}

/**
 * Accept an absolute URL with one of the given schemes and no credentials, fragment, or whitespace.
 * Messages name the variable but never repeat its value, which may be sensitive.
 */
function serviceUrl(
  name: string,
  value: string,
  schemes: readonly string[],
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (
    !schemes.includes(url.protocol) ||
    url.username ||
    url.password ||
    value.includes("#") ||
    /\s/.test(value)
  )
    throw new Error(
      `${name} must be a ${schemes.join(" or ")} URL without credentials or a fragment`,
    );
  return url.href;
}
