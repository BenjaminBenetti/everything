import { Type } from "typebox";
import {
  artifactCapabilities,
  artifactVisibilities,
} from "@everything/artifact-contracts";

const author = Type.Object({ id: Type.String(), name: Type.String() });

/** One app as its owner sees it, without deployment secrets or internal service addresses. */
export const artifactSummaryResponse = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  kind: Type.Union([Type.Literal("static"), Type.Literal("dynamic")]),
  title: Type.String(),
  description: Type.String(),
  database: Type.Boolean(),
  capabilities: Type.Array(
    Type.Union(artifactCapabilities.map((value) => Type.Literal(value))),
  ),
  url: Type.String(),
  visibility: Type.Union(
    artifactVisibilities.map((value) => Type.Literal(value)),
  ),
  status: Type.Union(
    ["unpublished", "live", "stopped", "starting", "running", "failing"].map(
      (value) => Type.Literal(value),
    ),
  ),
  release: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  createdBy: author,
  updatedBy: author,
});

/** The owner-visible app directory. */
export const artifactListResponse = Type.Object({
  artifacts: Type.Array(artifactSummaryResponse),
});

/** A link that signs the viewer into the separate app origin. */
export const artifactViewResponse = Type.Object({ url: Type.String() });

/** A dynamic app's API key, which external callers send in the X-Api-Key header. */
export const artifactApiKeyResponse = Type.Object({ apiKey: Type.String() });
