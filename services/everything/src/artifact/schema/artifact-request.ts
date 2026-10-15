import { Type, type Static } from "typebox";
import {
  artifactLimits,
  artifactSlugPattern,
} from "@everything/artifact-contracts";

/** Request body asking to open an artifact, optionally at a path inside it. */
export const artifactViewBody = Type.Object(
  {
    slug: Type.String({
      pattern: artifactSlugPattern,
      maxLength: artifactLimits.slugLength,
    }),
    path: Type.Optional(
      Type.String({
        pattern: "^/(?!/)[^\\\\\\s]*$",
        maxLength: artifactLimits.viewPathLength,
      }),
    ),
  },
  { additionalProperties: false },
);

/** Validated request to open an artifact. */
export type ArtifactViewBody = Static<typeof artifactViewBody>;

/** Public lifecycle requests identify an app from the authenticated owner's library. */
export const appParams = Type.Object(
  { appId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

/** Validated app identifier for a manual lifecycle request. */
export type AppParams = Static<typeof appParams>;
