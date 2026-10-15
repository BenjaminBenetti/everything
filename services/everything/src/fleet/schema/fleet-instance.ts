import { Type, type Static } from "typebox";

/** Only consume the fields needed by the workspace directory. */
export const fleetInstanceSchema = Type.Object({
  fleet: Type.String({ minLength: 1 }),
  instance: Type.String({ minLength: 1 }),
  status: Type.String(),
  container_id: Type.Optional(Type.String()),
});

export const fleetInstanceListSchema = Type.Object({
  instances: Type.Array(fleetInstanceSchema),
});
export const fleetJobSchema = Type.Object({
  done: Type.Boolean(),
  success: Type.Optional(Type.Boolean()),
});
export type FleetInstance = Static<typeof fleetInstanceSchema>;
