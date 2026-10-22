import { Type, type Static } from "typebox";
import { environmentNamePattern } from "@everything/artifact-contracts";
import { appCredentialLimits } from "@everything/artifact-contracts/credential";
import { artifactParams } from "../../artifact/schema/artifact-request.js";

/** A credential version number. */
const version = Type.Integer({ minimum: 1, maximum: 2147483647 });

/** A value; its byte length, NUL characters, and Unicode form are checked by the service. */
const value = Type.String({
  minLength: 1,
  maxLength: appCredentialLimits.valueBytes,
});

/** A variable a credential is read from; reserved names are refused by the service. */
const env = Type.String({
  pattern: environmentNamePattern,
  maxLength: appCredentialLimits.envLength,
});

/** A credential Everything grants to an app, with the value to store for it. */
export const credentialGrant = Type.Object(
  {
    credentialId: Type.String({ format: "uuid" }),
    env,
    version,
    value,
  },
  { additionalProperties: false },
);

/** Validated credential grant. */
export type CredentialGrantBody = Static<typeof credentialGrant>;

/** Every credential an app should receive, replacing its current set. */
export const credentialGrants = Type.Array(credentialGrant, {
  maxItems: appCredentialLimits.count,
});

/** Route parameters naming one credential. */
export const credentialParams = Type.Object(
  { credentialId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

/** Validated route parameters naming one credential. */
export type CredentialParams = Static<typeof credentialParams>;

/** Route parameters naming one credential of one app by its variable. */
export const appCredentialParams = Type.Object(
  { ...artifactParams.properties, env },
  { additionalProperties: false },
);

/** Validated route parameters naming one app credential. */
export type AppCredentialParams = Static<typeof appCredentialParams>;

/** A credential's new value and its version. */
export const credentialValueBody = Type.Object(
  { version, value },
  { additionalProperties: false },
);

/** Validated new value. */
export type CredentialValueBody = Static<typeof credentialValueBody>;
