import { Type, type Static } from "typebox";

/** A required, non-empty setting. */
const required = Type.String({ minLength: 1 });

/** Runtime-validated deployment configuration, shared with TypeScript through TypeBox. */
export const environmentSchema = Type.Object({
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8080 }),
  OIDC_ISSUER: required,
  OIDC_JWKS_URL: required,
  OIDC_AUDIENCE: required,
  DATABASE_URL: Type.String({ pattern: "^postgres(?:ql)?://" }),
  DATABASE_PASSWORD: required,
  PI_STATE_DIRECTORY: required,
  AGENTS_DIRECTORY: Type.String({ pattern: "^/" }),
});

/** Deployment settings after env-schema validation and defaults. */
export type EnvironmentSettings = Static<typeof environmentSchema>;
