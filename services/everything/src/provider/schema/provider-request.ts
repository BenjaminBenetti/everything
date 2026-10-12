import { Type, type Static } from "typebox";
import { providerIds, providerLimits } from "@everything/provider-contracts";

/** Route identifiers remain a closed, validated provider catalog. */
export const providerParams = Type.Object(
  { provider: Type.Union(providerIds.map((id) => Type.Literal(id))) },
  { additionalProperties: false },
);
export type ProviderParams = Static<typeof providerParams>;
export const apiKeyProviderParams = Type.Object(
  {
    provider: Type.Union([
      Type.Literal("anthropic"),
      Type.Literal("openai-compatible"),
    ]),
  },
  { additionalProperties: false },
);
export type ApiKeyProviderParams = Static<typeof apiKeyProviderParams>;

/** Optional key omission retains a saved key; explicit empty keys support local servers. */
export const saveProviderBody = Type.Object(
  {
    apiKey: Type.Optional(
      Type.String({ maxLength: providerLimits.apiKeyLength }),
    ),
    baseUrl: Type.Optional(
      Type.String({ maxLength: providerLimits.addressLength }),
    ),
    model: Type.Optional(
      Type.String({ maxLength: providerLimits.modelLength }),
    ),
  },
  { additionalProperties: false },
);
export type SaveProviderBody = Static<typeof saveProviderBody>;

/** Authorization codes are submitted in a protected body, never as authenticated API query parameters. */
export const completeProviderBody = Type.Object(
  {
    callback: Type.String({
      minLength: 1,
      maxLength: providerLimits.callbackLength,
    }),
  },
  { additionalProperties: false },
);
export type CompleteProviderBody = Static<typeof completeProviderBody>;
