import { Type, type Static } from "typebox";

/** A required, non-empty setting. */
const required = Type.String({ minLength: 1 });

/** An origin without a path, such as `https://artifacts.example.com`. */
const origin = Type.String({ pattern: "^https?://[^/]+$" });

/** A Kubernetes namespace or object name. */
const kubernetesName = Type.String({
  pattern: "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$",
  maxLength: 253,
});

/** A host with an optional port, such as `registry.example.com` or `registry:5000`. */
const hostAndPort = Type.String({ pattern: "^[A-Za-z0-9.-]+(:[0-9]+)?$" });

/** Runtime-validated deployment configuration, shared with TypeScript through TypeBox. */
export const environmentSchema = Type.Object({
  /** Port serving the artifact host through the Ingress. */
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8080 }),
  /** Port serving the internal API, reachable only inside the cluster. */
  INTERNAL_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8081 }),
  /** Port serving the public apps host, anonymous and credential-free, through its own Ingress. */
  PUBLIC_APPS_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8082 }),
  PUBLIC_ORIGIN: origin,
  ARTIFACT_ORIGIN: origin,
  /**
   * Origin that serves public apps to anyone. Its hostname differs from the artifact host's and the
   * application's, so a public app's pages run under their own browser trust boundary and receive
   * none of the cookies, signed-in or app-owned, or stored data of the artifact host, where private
   * apps are served. A different port is not enough: browsers share a hostname's cookies across ports.
   */
  PUBLIC_APPS_ORIGIN: origin,
  OIDC_ISSUER: required,
  OIDC_JWKS_URL: required,
  OIDC_AUDIENCE: required,
  EVERYTHING_API_URL: Type.String({ pattern: "^https?://[^/]+$" }),
  EVERYTHING_API_AUDIENCE: required,
  KEYCLOAK_ADMIN_URL: Type.String({
    pattern: "^https?://[^/]+/auth/admin/realms/[^/]+$",
  }),
  KEYCLOAK_PROTOCOL_URL: Type.String({
    pattern: "^https?://[^/]+/auth/realms/[^/]+/protocol/openid-connect$",
  }),
  APP_PROVISIONER_CLIENT_ID: required,
  APP_PROVISIONER_CLIENT_SECRET: required,
  DATABASE_URL: Type.String({ pattern: "^postgres(?:ql)?://" }),
  DATABASE_PASSWORD: required,
  ARTIFACT_DATA_DATABASE: required,
  ARTIFACT_DATABASE_HOST: hostAndPort,
  CONTENT_DIRECTORY: Type.String({ pattern: "^/" }),
  ARTIFACT_NAMESPACE: kubernetesName,
  BUILD_NAMESPACE: kubernetesName,
  ARTIFACT_STORAGE_CLASS: Type.String({ default: "" }),
  REGISTRY_URL: Type.String({ pattern: "^https?://[^/]+$" }),
  REGISTRY_USERNAME: required,
  REGISTRY_PASSWORD: required,
  REGISTRY_PUSH_HOST: hostAndPort,
  REGISTRY_PULL_HOST: hostAndPort,
  REGISTRY_PULL_SECRET: kubernetesName,
  REGISTRY_PUSH_SECRET: kubernetesName,
  BUILD_SOURCE_URL: Type.String({ pattern: "^https?://[^/]+$" }),
  BUILDKIT_IMAGE: required,
});

/** Deployment settings after env-schema validation and defaults. */
export type EnvironmentSettings = Static<typeof environmentSchema>;
