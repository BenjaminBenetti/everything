import { Type } from "typebox";
import { artifactCapabilities } from "@everything/artifact-contracts";
import { appCredentialResponse } from "../../key/schema/key-response.js";

const author = Type.Object({ id: Type.String(), name: Type.String() });

/** The owner-visible app directory excludes deployment secrets and internal service addresses. */
export const artifactListResponse = Type.Object({
  artifacts: Type.Array(
    Type.Object({
      id: Type.String(),
      slug: Type.String(),
      kind: Type.Union([Type.Literal("static"), Type.Literal("dynamic")]),
      title: Type.String(),
      description: Type.String(),
      database: Type.Boolean(),
      capabilities: Type.Array(
        Type.Union(artifactCapabilities.map((value) => Type.Literal(value))),
      ),
      credentials: Type.Array(appCredentialResponse),
      url: Type.String(),
      status: Type.Union(
        [
          "unpublished",
          "live",
          "stopped",
          "starting",
          "running",
          "failing",
        ].map((value) => Type.Literal(value)),
      ),
      release: Type.Integer(),
      createdAt: Type.String(),
      updatedAt: Type.String(),
      createdBy: author,
      updatedBy: author,
    }),
  ),
});

/** A link that signs the viewer into the separate app origin. */
export const artifactViewResponse = Type.Object({ url: Type.String() });

/** A dynamic app's API key, which external callers send in the X-Api-Key header. */
export const artifactApiKeyResponse = Type.Object({ apiKey: Type.String() });
