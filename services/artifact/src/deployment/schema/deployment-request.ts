import { Type, type Static } from "typebox";
import {
  artifactLimits,
  artifactCapabilities,
  environmentNamePattern,
} from "@everything/artifact-contracts";
import { credentialGrants } from "../../credential/schema/credential-request.js";

/** Request body deploying a build; omitted settings keep the live deployment's values. */
export const deployBody = Type.Object(
  {
    build: Type.Optional(Type.Integer({ minimum: 1 })),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    env: Type.Optional(
      Type.Record(
        Type.String({ pattern: environmentNamePattern }),
        Type.String({ maxLength: artifactLimits.envValueLength }),
        { maxProperties: artifactLimits.envCount, additionalProperties: false },
      ),
    ),
    database: Type.Optional(Type.Boolean()),
    capabilities: Type.Optional(
      Type.Array(
        Type.Union(artifactCapabilities.map((name) => Type.Literal(name))),
        {
          uniqueItems: true,
          maxItems: artifactCapabilities.length,
        },
      ),
    ),
    credentials: Type.Optional(credentialGrants),
    diskGi: Type.Optional(
      Type.Union([
        Type.Integer({ minimum: 1, maximum: artifactLimits.diskGi }),
        Type.Null(),
      ]),
    ),
    healthPath: Type.Optional(
      Type.Union([
        Type.String({ pattern: "^/[^\\s]*$", maxLength: 1024 }),
        Type.Null(),
      ]),
    ),
    basedOn: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** Validated request body deploying a build. */
export type DeployBody = Static<typeof deployBody>;

/** Query choosing which container output to read. */
export const logsQuery = Type.Object(
  {
    previous: Type.Optional(
      Type.Union([Type.Literal("true"), Type.Literal("false")]),
    ),
    lines: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,3}$" })),
  },
  { additionalProperties: false },
);

/** Validated log query. */
export type LogsQuery = Static<typeof logsQuery>;
