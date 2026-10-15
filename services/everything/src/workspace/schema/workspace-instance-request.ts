import { Type, type Static } from "typebox";
import { workspaceInstanceLimits } from "@everything/workspace-contracts/instance";

const name = Type.String({
  minLength: 1,
  maxLength: workspaceInstanceLimits.nameLength,
  pattern: "^(?!\\.{1,2}$)[^\\s/\\\\\\u0000-\\u001f]+$",
});

/** Explicit names prevent runtime target inference and fleet-wide actions. */
export const workspaceInstanceBody = Type.Object(
  { type: name, name },
  { additionalProperties: false },
);

export type WorkspaceInstanceBody = Static<typeof workspaceInstanceBody>;
