import { Type } from "typebox";
import { providerIds } from "@everything/provider-contracts";
import { inferenceEfforts } from "@everything/provider-contracts/inference";

const nullableText = Type.Union([Type.String(), Type.Null()]);
const effort = Type.Union(inferenceEfforts.map((value) => Type.Literal(value)));

/** Public connection state never includes stored provider credentials. */
export const providerResponse = Type.Object({
  provider: Type.Union(providerIds.map((id) => Type.Literal(id))),
  configured: Type.Boolean(),
  status: Type.Union(
    ["disconnected", "unverified", "verified", "error"].map((value) =>
      Type.Literal(value),
    ),
  ),
  baseUrl: nullableText,
  model: nullableText,
  account: nullableText,
  verifiedAt: nullableText,
  lastCheckedAt: nullableText,
  message: nullableText,
});

/** Supported provider connections for the authenticated owner. */
export const providerListResponse = Type.Object({
  providers: Type.Array(providerResponse),
});

/** Connection revocation status, without upstream response details. */
export const providerDisconnectionResponse = Type.Object({
  message: nullableText,
});

/** A browser authorization link and its expiry; tokens remain private. */
export const providerAuthorizationResponse = Type.Object({
  url: Type.String(),
  redirectUri: Type.String(),
  expiresAt: Type.String(),
});

/** Model and effort choices available through an active connection. */
export const providerModelsResponse = Type.Object({
  models: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      efforts: Type.Array(effort),
      defaultEffort: effort,
    }),
  ),
});
