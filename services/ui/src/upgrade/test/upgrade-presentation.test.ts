import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  UpgradeAttempt,
  UpgradeStatus,
} from "@everything/upgrade-contracts";
import { presentUpgrade } from "../model/upgrade-presentation.js";

const ready: UpgradeStatus = {
  availability: "ready",
  currentVersion: "0.1.0-rc7",
  latestVersion: "0.1.0-rc8",
  versionsChecked: true,
  lastUpgrade: null,
};

/** An upgrade from rc7 to rc8 in the given state. */
function attempt(
  state: UpgradeAttempt["state"],
  failure: string | null = null,
): UpgradeAttempt {
  return {
    fromVersion: "0.1.0-rc7",
    toVersion: "0.1.0-rc8",
    state,
    startedAt: "2026-10-17T10:00:00Z",
    finishedAt: state === "running" ? null : "2026-10-17T10:04:00Z",
    failure,
  };
}

test("offers the newest version, or says the installation is current or couldn't be checked", () => {
  assert.deepEqual(presentUpgrade(ready, null), {
    offer: { kind: "available", version: "0.1.0-rc8" },
    notice: null,
  });
  assert.deepEqual(
    presentUpgrade({ ...ready, latestVersion: null }, null).offer,
    {
      kind: "current",
    },
  );
  assert.deepEqual(
    presentUpgrade(
      { ...ready, latestVersion: null, versionsChecked: false },
      null,
    ).offer,
    { kind: "unchecked" },
  );
});

test("installations the installer upgrades say so instead of offering versions", () => {
  assert.deepEqual(
    presentUpgrade({ ...ready, availability: "not-configured" }, null).offer,
    { kind: "installer" },
  );
  assert.deepEqual(
    presentUpgrade({ ...ready, availability: "needs-installer" }, null).offer,
    { kind: "needs-installer" },
  );
});

test("a running upgrade replaces the offer", () => {
  assert.deepEqual(
    presentUpgrade({ ...ready, lastUpgrade: attempt("running") }, null),
    {
      offer: { kind: "running", version: "0.1.0-rc8" },
      notice: null,
    },
  );
});

test("only the page that followed an upgrade offers to reload once it succeeds", () => {
  const upgraded: UpgradeStatus = {
    ...ready,
    currentVersion: "0.1.0-rc8",
    latestVersion: null,
    lastUpgrade: attempt("succeeded"),
  };
  assert.deepEqual(presentUpgrade(upgraded, "0.1.0-rc8").notice, {
    kind: "upgraded",
    version: "0.1.0-rc8",
  });
  assert.equal(presentUpgrade(upgraded, null).notice, null);
});

test("a failed upgrade is explained while the installation stays on the version it started from", () => {
  const failed = {
    ...ready,
    lastUpgrade: attempt("failed", "Error: UPGRADE FAILED: timed out"),
  };
  assert.deepEqual(presentUpgrade(failed, "0.1.0-rc8"), {
    offer: { kind: "available", version: "0.1.0-rc8" },
    notice: {
      kind: "failed",
      version: "0.1.0-rc8",
      reason: "Error: UPGRADE FAILED: timed out",
    },
  });
  // Once upgraded some other way, the old failure no longer applies.
  assert.equal(
    presentUpgrade(
      { ...failed, currentVersion: "0.1.0-rc9", latestVersion: null },
      null,
    ).notice,
    null,
  );
});
