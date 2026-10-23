import { Type } from "typebox";
import { keyLimits } from "@everything/key-contracts";
import { appCredentialStatuses } from "@everything/artifact-contracts/credential";

/** Explicit metadata schema is a second boundary against returning secret fields. */
export const keyResponse = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    name: Type.String({ maxLength: keyLimits.nameLength }),
    type: Type.String({ maxLength: keyLimits.typeLength }),
    createdAt: Type.String({ format: "date-time" }),
    availability: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("ready"),
        Type.Literal("unavailable"),
      ]),
    ),
    description: Type.Optional(
      Type.String({ maxLength: keyLimits.descriptionLength }),
    ),
    updatedAt: Type.Optional(Type.String({ format: "date-time" })),
    status: Type.Optional(Type.Literal("removing")),
    owned: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const keyListResponse = Type.Object(
  { keys: Type.Array(keyResponse) },
  { additionalProperties: false },
);

/** A credential's status in one of the caller's apps. */
const credentialStatus = Type.Union(
  appCredentialStatuses.map((status) => Type.Literal(status)),
);

/** The caller's apps that use a credential, and a count of other accounts' apps. */
export const credentialUsageResponse = Type.Object(
  {
    apps: Type.Array(
      Type.Object(
        {
          appId: Type.String({ format: "uuid" }),
          slug: Type.String(),
          title: Type.String(),
          env: Type.String(),
          status: credentialStatus,
        },
        { additionalProperties: false },
      ),
    ),
    otherApps: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Where apps stand after a credential's value was replaced or it was deleted. */
export const credentialRolloutResponse = Type.Object(
  {
    complete: Type.Boolean(),
    usage: Type.Union([credentialUsageResponse, Type.Null()]),
  },
  { additionalProperties: false },
);

/** A replaced credential's metadata and its rollout to apps. */
export const keyReplacementResponse = Type.Object(
  { key: keyResponse, rollout: credentialRolloutResponse },
  { additionalProperties: false },
);

/** A deleted generic credential's removal from apps. */
export const keyRemovalResponse = Type.Object(
  { rollout: credentialRolloutResponse },
  { additionalProperties: false },
);

/** One app credential: identifiers, name, and status, never its value. */
export const appCredentialResponse = Type.Object(
  {
    credentialId: Type.String({ format: "uuid" }),
    name: Type.Union([Type.String(), Type.Null()]),
    env: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    status: credentialStatus,
  },
  { additionalProperties: false },
);

/** An app's credentials after one was attached or removed. */
export const appCredentialListResponse = Type.Object(
  { credentials: Type.Array(appCredentialResponse) },
  { additionalProperties: false },
);
