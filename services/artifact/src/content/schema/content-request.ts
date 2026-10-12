import { Type, type Static } from "typebox";
import {
  artifactLimits,
  contentHashPattern,
} from "@everything/artifact-contracts";

/** A content address. */
const contentHash = Type.String({ pattern: contentHashPattern });

/** One file of a revision or build source; path rules are checked by the manifest validator. */
export const artifactFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: artifactLimits.pathLength }),
    sha256: contentHash,
    size: Type.Integer({ minimum: 0, maximum: artifactLimits.fileSize }),
    executable: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** The files of a revision or build source. */
export const fileListSchema = Type.Array(artifactFileSchema, {
  minItems: 1,
  maxItems: artifactLimits.fileCount,
});

/** Hashes to check before uploading. */
export const missingContentBody = Type.Object(
  {
    hashes: Type.Array(contentHash, { maxItems: artifactLimits.fileCount }),
  },
  { additionalProperties: false },
);

/** Validated hashes to check before uploading. */
export type MissingContentBody = Static<typeof missingContentBody>;

/** Route parameters naming stored content. */
export const contentParams = Type.Object(
  { sha256: contentHash },
  { additionalProperties: false },
);

/** Validated route parameters naming stored content. */
export type ContentParams = Static<typeof contentParams>;
