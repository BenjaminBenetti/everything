import { Type, type Static } from "typebox";
import {
  artifactParams,
  queryNumber,
} from "../../artifact/schema/artifact-request.js";
import { fileListSchema } from "../../content/schema/content-request.js";

/** A live release number the change was based on. */
const basedOn = Type.Optional(Type.Integer({ minimum: 0 }));

/** Request body publishing uploaded files as a new revision. */
export const publishRevisionBody = Type.Object(
  { files: fileListSchema, basedOn },
  { additionalProperties: false },
);

/** Validated request body publishing a revision. */
export type PublishRevisionBody = Static<typeof publishRevisionBody>;

/** Route parameters naming one revision of an artifact. */
export const revisionParams = Type.Object(
  { ...artifactParams.properties, number: queryNumber },
  { additionalProperties: false },
);

/** Validated route parameters naming one revision. */
export type RevisionParams = Static<typeof revisionParams>;

/** Request body making an earlier revision live. */
export const activateRevisionBody = Type.Object(
  { basedOn },
  { additionalProperties: false },
);

/** Validated request body making an earlier revision live. */
export type ActivateRevisionBody = Static<typeof activateRevisionBody>;
