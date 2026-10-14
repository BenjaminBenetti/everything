import { Type, type Static } from "typebox";

/** A complete replacement of the workspace's worker settings. */
export const workerSettingsBody = Type.Object(
  { privileged: Type.Boolean() },
  { additionalProperties: false },
);

export type WorkerSettingsBody = Static<typeof workerSettingsBody>;
