import { Type } from "typebox";
import { providerIds } from "@everything/provider-contracts";

/** Only validated, credential-free runtime facts cross the HTTP boundary. */
const effectiveModel = Type.Object({
  provider: Type.Union(providerIds.map((id) => Type.Literal(id))),
  model: Type.String(),
  contextWindow: Type.Integer({ minimum: 1 }),
  contextSource: Type.Union([
    Type.Literal("provider"),
    Type.Literal("catalog"),
    Type.Literal("fallback"),
  ]),
  imageInput: Type.Union([Type.Boolean(), Type.Null()]),
  imageSource: Type.Union([
    Type.Literal("provider"),
    Type.Literal("documentation"),
    Type.Literal("catalog"),
    Type.Literal("unknown"),
  ]),
});

/** The runtime may retain older metadata even when the current selection is unavailable. */
export const agentModelInfoResponse = Type.Object({
  selected: Type.Union([effectiveModel, Type.Null()]),
  applied: Type.Union([effectiveModel, Type.Null()]),
  selectionError: Type.Boolean(),
});
