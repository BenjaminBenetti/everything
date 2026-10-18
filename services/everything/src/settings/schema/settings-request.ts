import { Type, type Static } from "typebox";
import { teammateOrderLimits } from "@everything/settings-contracts";

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

/** A complete replacement of the signed-in owner's teammate order; each teammate appears once. */
export const teammateOrderBody = Type.Object(
  {
    teammateIds: Type.Array(Type.String({ format: "uuid" }), {
      maxItems: teammateOrderLimits.teammateCount,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export type TeammateOrderBody = Static<typeof teammateOrderBody>;
