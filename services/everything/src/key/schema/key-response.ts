import { Type } from "typebox";
import { keyLimits } from "@everything/key-contracts";

/** Explicit metadata schema is a second boundary against returning secret fields. */
export const keyResponse = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    name: Type.String({ maxLength: keyLimits.nameLength }),
    type: Type.String({ maxLength: keyLimits.typeLength }),
    createdAt: Type.String({ format: "date-time" }),
    availability: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("ready"),
        Type.Literal("unavailable"),
      ]),
    ),
  },
  { additionalProperties: false },
);
export const keyListResponse = Type.Object(
  { keys: Type.Array(keyResponse) },
  { additionalProperties: false },
);
