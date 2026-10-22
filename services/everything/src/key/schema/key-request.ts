import { Type, type Static } from "typebox";
import { keyLimits } from "@everything/key-contracts";
import { nonBlankText } from "../../http/schema/text-schema.js";

export const keyParams = Type.Object(
  { keyId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export type KeyParams = Static<typeof keyParams>;

/** A generic credential's description; SSH keys ignore it. */
const description = Type.String({ maxLength: keyLimits.descriptionLength });

export const createKeyBody = Type.Object(
  {
    name: nonBlankText(keyLimits.nameLength),
    type: nonBlankText(keyLimits.typeLength),
    material: nonBlankText(keyLimits.materialLength),
    description: Type.Optional(description),
  },
  { additionalProperties: false },
);
export type CreateKeyBody = Static<typeof createKeyBody>;

export const renameKeyBody = Type.Object(
  {
    name: nonBlankText(keyLimits.nameLength),
    description: Type.Optional(description),
  },
  { additionalProperties: false },
);
export type RenameKeyBody = Static<typeof renameKeyBody>;

/** A generic credential's new value; its byte length and characters are checked by the service. */
export const replaceKeyValueBody = Type.Object(
  { material: nonBlankText(keyLimits.materialLength) },
  { additionalProperties: false },
);
export type ReplaceKeyValueBody = Static<typeof replaceKeyValueBody>;
