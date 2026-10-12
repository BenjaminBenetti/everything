import { Type, type Static } from "typebox";
import {
  artifactParams,
  queryNumber,
} from "../../artifact/schema/artifact-request.js";
import {
  artifactLimits,
  environmentNamePattern,
} from "@everything/artifact-contracts";
import { fileListSchema } from "../../content/schema/content-request.js";

/** Request body starting a build of uploaded source. */
export const startBuildBody = Type.Object(
  {
    files: fileListSchema,
    dockerfile: Type.String({
      minLength: 1,
      maxLength: artifactLimits.pathLength,
    }),
    buildArgs: Type.Record(
      Type.String({ pattern: environmentNamePattern }),
      Type.String({ maxLength: artifactLimits.envValueLength }),
      {
        maxProperties: artifactLimits.buildArgCount,
        additionalProperties: false,
      },
    ),
  },
  { additionalProperties: false },
);

/** Validated request body starting a build. */
export type StartBuildBody = Static<typeof startBuildBody>;

/** Route parameters naming one build of an artifact. */
export const buildParams = Type.Object(
  { ...artifactParams.properties, number: queryNumber },
  { additionalProperties: false },
);

/** Validated route parameters naming one build. */
export type BuildParams = Static<typeof buildParams>;

/** Route parameters and query of a build job downloading its source. */
export const buildSourceParams = Type.Object(
  { buildId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

/** Validated build ID of a source download. */
export type BuildSourceParams = Static<typeof buildSourceParams>;

/** The source token issued with the build job. */
export const buildSourceQuery = Type.Object(
  { token: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);

/** Validated source token. */
export type BuildSourceQuery = Static<typeof buildSourceQuery>;
