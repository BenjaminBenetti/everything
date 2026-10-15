import { Type, type Static } from "typebox";
import {
  artifactKinds,
  artifactLimits,
  artifactSlugPattern,
} from "@everything/artifact-contracts";
import { nonBlankText } from "../../http/schema/text-schema.js";

/** An authenticated subject, as asserted by Everything. */
const ownerId = Type.String({ minLength: 1, maxLength: 200 });

/** A whole number written in a query string. */
export const queryNumber = Type.String({ pattern: "^[1-9][0-9]{0,8}$" });

/** Route parameters naming the owner. */
export const ownerParams = Type.Object(
  { ownerId },
  { additionalProperties: false },
);

/** Validated route parameters naming the owner. */
export type OwnerParams = Static<typeof ownerParams>;

/** Route parameters naming one of the owner's artifacts by ID or slug. */
export const artifactParams = Type.Object(
  { ownerId, artifact: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);

/** Validated route parameters naming one artifact. */
export type ArtifactParams = Static<typeof artifactParams>;

/** Require an app to stay stopped while the owner confirms deletion. */
export const deleteArtifactQuery = Type.Object(
  { requireStopped: Type.Optional(Type.Literal("true")) },
  { additionalProperties: false },
);

/** Validated deletion policy sent by the trusted gateway. */
export type DeleteArtifactQuery = Static<typeof deleteArtifactQuery>;

/** Request body for creating an artifact. */
export const createArtifactBody = Type.Object(
  {
    slug: Type.String({
      pattern: artifactSlugPattern,
      maxLength: artifactLimits.slugLength,
    }),
    kind: Type.Union(artifactKinds.map((kind) => Type.Literal(kind))),
    title: nonBlankText(artifactLimits.titleLength),
    description: Type.String({ maxLength: artifactLimits.descriptionLength }),
  },
  { additionalProperties: false },
);

/** Validated request body for creating an artifact. */
export type CreateArtifactBody = Static<typeof createArtifactBody>;

/** Request body changing at least one descriptive field. */
export const updateArtifactBody = Type.Object(
  {
    title: Type.Optional(nonBlankText(artifactLimits.titleLength)),
    description: Type.Optional(
      Type.String({ maxLength: artifactLimits.descriptionLength }),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

/** Validated request body changing descriptive fields. */
export type UpdateArtifactBody = Static<typeof updateArtifactBody>;

/** Query choosing which source to check out. */
export const sourceQuery = Type.Object(
  { revision: Type.Optional(queryNumber), build: Type.Optional(queryNumber) },
  { additionalProperties: false, maxProperties: 1 },
);

/** Validated source choice. */
export type SourceQuery = Static<typeof sourceQuery>;
