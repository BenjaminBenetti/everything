import { Type, type Static } from "typebox";
import { keyLimits } from "@everything/key-contracts";
import { nonBlankText } from "../../http/schema/text-schema.js";

export const keyParams = Type.Object(
  { keyId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export type KeyParams = Static<typeof keyParams>;

export const createKeyBody = Type.Object(
  {
    name: nonBlankText(keyLimits.nameLength),
    type: nonBlankText(keyLimits.typeLength),
    material: nonBlankText(keyLimits.materialLength),
  },
  { additionalProperties: false },
);
export type CreateKeyBody = Static<typeof createKeyBody>;

export const renameKeyBody = Type.Object(
  { name: nonBlankText(keyLimits.nameLength) },
  { additionalProperties: false },
);
export type RenameKeyBody = Static<typeof renameKeyBody>;
