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
      description: "A published version newer than the installed one.",
    }),
  },
  { additionalProperties: false },
);

export type StartUpgradeBody = Static<typeof startUpgradeBody>;

/** The most recent upgrade started from Everything. */
const upgradeAttempt = Type.Object({
  fromVersion: Type.String(),
  toVersion: Type.String(),
  state: Type.Union([
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
  ]),
  startedAt: Type.String({ format: "date-time" }),
  finishedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  failure: Type.Union([Type.String(), Type.Null()], {
    description:
      "Why a failed upgrade stopped; the installation stays on its previous version.",
  }),
});

/** The installation's version, the newest it can upgrade to, and its latest upgrade. */
export const upgradeStatusResponse = Type.Object({
  availability: Type.Union(
    [
      Type.Literal("ready"),
      Type.Literal("not-configured"),
      Type.Literal("needs-installer"),
    ],
    {
      description:
        "ready: Everything can upgrade itself. not-configured: the installer upgrades this installation. needs-installer: run the installer once more to let Everything upgrade itself.",
    },
  ),
  currentVersion: Type.String(),
  latestVersion: Type.Union([Type.String(), Type.Null()]),
  versionsChecked: Type.Boolean({
    description:
      "Whether the published versions could be read, so a null latestVersion means up to date.",
  }),
  lastUpgrade: Type.Union([upgradeAttempt, Type.Null()]),
});
