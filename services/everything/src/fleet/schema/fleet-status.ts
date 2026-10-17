import { Type } from "typebox";

/** Fleet names include fleets with no instances, which instance listings omit. */
export const fleetStatusSchema = Type.Object({
  fleets: Type.Array(Type.Object({ fleet: Type.String({ minLength: 1 }) })),
});
