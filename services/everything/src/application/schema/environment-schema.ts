import { Type, type Static } from "typebox";
import { workspaceRoot } from "@everything/workspace-contracts/mount";

/** A required, non-empty setting. */
const required = Type.String({ minLength: 1 });

/** Runtime-validated deployment configuration, shared with TypeScript through TypeBox. */
export const environmentSchema = Type.Object({
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8080 }),
  OIDC_ISSUER: required,
  OIDC_JWKS_URL: required,
  OIDC_AUDIENCE: required,
  PUBLIC_ORIGIN: Type.String({ pattern: "^https?://[^/]+$" }),
  CHATGPT_REDIRECT_URI: Type.String({
    pattern: "^http://127\\.0\\.0\\.1:[0-9]+/v1/providers/chatgpt/callback$",
    default: "http://127.0.0.1:8080/v1/providers/chatgpt/callback",
  }),
  OIDC_PROTOCOL_URL: Type.String({ pattern: "^https?://" }),
  OIDC_CLIENT_ID: required,
  OIDC_CLIENT_SECRET: required,
  SESSION_ENCRYPTION_KEY: Type.String({ pattern: "^[A-Za-z0-9+/]{43}=$" }),
  DATABASE_URL: Type.String({ pattern: "^postgres(?:ql)?://" }),
  DATABASE_PASSWORD: required,
  PI_STATE_DIRECTORY: required,
  /** Where the workspace volume is mounted: teammate pods mount their folders at the same paths. */
  AGENTS_DIRECTORY: Type.String({ const: workspaceRoot }),
  WORKSPACE_NAMESPACE: required,
  WORKSPACE_TEMPLATE_NAME: required,
  WORKSPACE_CLAIM_NAME: required,
  /** Internal API of the artifact service, reachable inside the cluster. */
  ARTIFACT_SERVICE_URL: Type.String({ pattern: "^https?://[^/]+$" }),
  /** The artifact host as teammate pods reach it inside the cluster, over plain HTTP. */
  ARTIFACT_HOST_URL: Type.String({ pattern: "^https?://[^/]+$" }),
  /** Keycloak client whose service account calls the artifact service. */
  ARTIFACT_CLIENT_ID: required,
  ARTIFACT_CLIENT_SECRET: required,
  /** Fleet's home directory, on its own volume. */
  FLEET_HOME: Type.String({ pattern: "^/" }),
  /** Fleet release tag the chart pins. */
  FLEET_VERSION: Type.String({ pattern: "^v[0-9A-Za-z][0-9A-Za-z.+-]*$" }),
  /** Base URL of Fleet's release downloads, without a trailing slash. */
  FLEET_RELEASE_URL: Type.String({ pattern: "^https://[^?#]*[^/?#]$" }),
  /** JSON object of release file name to SHA-256; see `fleetChecksumsSchema`. */
  FLEET_CHECKSUMS: required,
  /** Namespace of Fleet's instances. */
  FLEET_NAMESPACE: required,
  /** Storage class of Fleet's instance disks; empty lets Fleet choose. */
  FLEET_STORAGE_CLASS: Type.String({ default: "" }),
  /** Registry host, with an optional port, that Fleet's images are pushed to and pulled from. */
  FLEET_REGISTRY: Type.String({ pattern: "^[^:/]+(:[0-9]{1,5})?$" }),
  /** Accept the registry's certificate unverified; only a development registry sets it. */
  FLEET_REGISTRY_INSECURE: Type.Boolean({ default: false }),
  REGISTRY_USERNAME: required,
  REGISTRY_PASSWORD: required,
});

/** Pinned SHA-256 of each Fleet release file, by file name. */
export const fleetChecksumsSchema = Type.Record(
  Type.String(),
  Type.String({ pattern: "^[0-9a-f]{64}$" }),
);

/** Deployment settings after env-schema validation and defaults. */
export type EnvironmentSettings = Static<typeof environmentSchema>;
