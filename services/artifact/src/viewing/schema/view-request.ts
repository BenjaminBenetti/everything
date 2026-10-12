import { Type, type Static } from "typebox";
import {
  artifactLimits,
  artifactSlugPattern,
} from "@everything/artifact-contracts";

/** Request body asking for a link that opens an artifact. */
export const viewBody = Type.Object(
  {
    slug: Type.String({
      pattern: artifactSlugPattern,
      maxLength: artifactLimits.slugLength,
    }),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);

/** Validated request for a view link. */
export type ViewBody = Static<typeof viewBody>;
