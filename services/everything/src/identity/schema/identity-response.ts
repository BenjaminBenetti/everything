import { Type } from "typebox";

/** Authenticated caller identity; app credentials resolve to their owner. */
export const identityResponse = Type.Object({ subject: Type.String() });
