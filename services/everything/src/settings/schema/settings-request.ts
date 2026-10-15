import { Type, type Static } from "typebox";

/** A complete replacement of the workspace's worker settings. */
export const workerSettingsBody = Type.Object(
  { privileged: Type.Boolean() },
  { additionalProperties: false },
);

export type WorkerSettingsBody = Static<typeof workerSettingsBody>;

/** A complete replacement of the signed-in owner's general preferences. */
export const generalSettingsBody = Type.Object(
  { summarizeUpdates: Type.Boolean() },
  { additionalProperties: false },
);

export type GeneralSettingsBody = Static<typeof generalSettingsBody>;
