import { Type, type Static } from "typebox";
import {
  releaseVersionMaxLength,
  releaseVersionPattern,
} from "@everything/upgrade-contracts";

/** The version to upgrade to. */
export const startUpgradeBody = Type.Object(
  {
    version: Type.String({
      pattern: releaseVersionPattern,
      maxLength: releaseVersionMaxLength,
    }),
  },
  { additionalProperties: false },
);

export type StartUpgradeBody = Static<typeof startUpgradeBody>;

/** One upgrade's outcome. */
const upgradeAttempt = Type.Object({
  fromVersion: Type.String(),
  toVersion: Type.String(),
  state: Type.Union([
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
  ]),
  startedAt: Type.String(),
  finishedAt: Type.Union([Type.String(), Type.Null()]),
  failure: Type.Union([Type.String(), Type.Null()]),
});

/** The installation's version, the newest it can upgrade to, and its latest upgrade. */
export const upgradeStatusResponse = Type.Object({
  availability: Type.Union([
    Type.Literal("ready"),
    Type.Literal("not-configured"),
    Type.Literal("needs-installer"),
  ]),
  currentVersion: Type.String(),
  latestVersion: Type.Union([Type.String(), Type.Null()]),
  versionsChecked: Type.Boolean(),
  lastUpgrade: Type.Union([upgradeAttempt, Type.Null()]),
});
