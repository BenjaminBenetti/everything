import { Type, type Static } from "typebox";
import { environmentNamePattern } from "@everything/artifact-contracts";
import { appCredentialLimits } from "@everything/artifact-contracts/credential";

/** A variable a credential is read from; reserved names are refused by the service. */
const env = Type.String({
  pattern: environmentNamePattern,
  maxLength: appCredentialLimits.envLength,
});

/** A request to give an app a credential the caller added. */
export const attachCredentialBody = Type.Object(
  { credentialId: Type.String({ format: "uuid" }), env },
  { additionalProperties: false },
);
export type AttachCredentialBody = Static<typeof attachCredentialBody>;

/** Route parameters naming one credential variable of one app. */
export const appCredentialParams = Type.Object(
  { appId: Type.String({ format: "uuid" }), env },
  { additionalProperties: false },
);
export type AppCredentialParams = Static<typeof appCredentialParams>;
