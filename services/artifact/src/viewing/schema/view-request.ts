import { Type, type Static } from "typebox";
import {
  artifactLimits,
  artifactSlugPattern,
} from "@everything/artifact-contracts";

/** A path inside the artifact; its form is checked by the viewing services. */
const viewPath = Type.String({
  minLength: 1,
  maxLength: artifactLimits.viewPathLength,
});

/** Request body asking for a link that opens an artifact. */
export const viewBody = Type.Object(
  {
    slug: Type.String({
      pattern: artifactSlugPattern,
      maxLength: artifactLimits.slugLength,
    }),
    path: Type.Optional(viewPath),
  },
  { additionalProperties: false },
);

/** Validated request for a view link. */
export type ViewBody = Static<typeof viewBody>;

/** Request body asking for a teammate's pass to the artifact named in the route. */
export const viewPassBody = Type.Object(
  { path: Type.Optional(viewPath) },
  { additionalProperties: false },
);

/** Validated request for a teammate pass. */
export type ViewPassBody = Static<typeof viewPassBody>;
