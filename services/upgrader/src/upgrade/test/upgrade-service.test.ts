import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpgradeAttempt } from "@everything/upgrade-contracts";
import type { UpgradeRequest } from "../interface/upgrade-jobs.js";
import { UpgradeService } from "../service/upgrade-service.js";

/** An upgrade service over in-memory versions, settings, and Jobs. */
function fixture(
  options: {
    chartConfigured?: boolean;
    saved?: boolean;
    published?: string[] | Error;
    latest?: UpgradeAttempt | null;
  } = {},
) {
  const started: UpgradeRequest[] = [];
  const listings: { fresh: boolean }[] = [];
  let latest = options.latest ?? null;
  const service = new UpgradeService(
    {
      currentVersion: "0.1.0-rc7",
      chartConfigured: options.chartConfigured ?? true,
    },
    {
      published: async (listing) => {
        listings.push({ fresh: listing?.fresh ?? false });
        if (options.published instanceof Error) throw options.published;
        return options.published ?? ["0.1.0-rc6", "0.1.0-rc7", "0.1.0-rc8"];
      },
    },
    { saved: async () => options.saved ?? true },
    {
      latest: async () => latest,
      start: async (request) => {
        started.push(request);
        latest = {
          ...request,
          state: "running",
          startedAt: "2026-10-17T10:00:00.000Z",
          finishedAt: null,
          failure: null,
        };
      },
    },
  );
  return { service, started, listings };
}

test("reports the newest upgrade and starts it after confirming it with a fresh listing", async () => {
  const { service, started, listings } = fixture();
  assert.deepEqual(await service.status(), {
    availability: "ready",
    currentVersion: "0.1.0-rc7",
    latestVersion: "0.1.0-rc8",
    versionsChecked: true,
    lastUpgrade: null,
  });
  const status = await service.start({ version: "0.1.0-rc8" });
  assert.deepEqual(started, [
    { fromVersion: "0.1.0-rc7", toVersion: "0.1.0-rc8" },
  ]);
  assert.equal(status.lastUpgrade?.state, "running");
  assert.deepEqual(
    listings.map((listing) => listing.fresh),
    [false, true, false],
  );
});

test("only newer published versions can be installed, so nothing can downgrade the installation", async () => {
  const { service, started } = fixture();
  for (const version of ["0.1.0-rc6", "0.1.0-rc7", "0.1.0-rc9", "9.9.9"])
    await assert.rejects(service.start({ version }), {
      code: "UPGRADE_VERSION_UNAVAILABLE",
    });
  assert.deepEqual(started, []);
});

test("one upgrade runs at a time, including simultaneous requests", async () => {
  const { service, started } = fixture();
  const results = await Promise.allSettled([
    service.start({ version: "0.1.0-rc8" }),
    service.start({ version: "0.1.0-rc8" }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(
    (results[1] as PromiseRejectedResult).reason.code,
    "UPGRADE_IN_PROGRESS",
  );
  assert.equal(started.length, 1);
});

test("upgrades need a configured chart and the installer's saved settings", async () => {
  const unconfigured = fixture({ chartConfigured: false });
  assert.equal(
    (await unconfigured.service.status()).availability,
    "not-configured",
  );
  assert.equal((await unconfigured.service.status()).versionsChecked, false);
  await assert.rejects(unconfigured.service.start({ version: "0.1.0-rc8" }), {
    code: "UPGRADES_NOT_CONFIGURED",
  });
  const unsaved = fixture({ saved: false });
  assert.equal(
    (await unsaved.service.status()).availability,
    "needs-installer",
  );
  await assert.rejects(unsaved.service.start({ version: "0.1.0-rc8" }), {
    code: "UPGRADE_SETTINGS_MISSING",
  });
  assert.deepEqual([...unconfigured.started, ...unsaved.started], []);
});

test("an unreachable registry leaves the newest version unknown and refuses to start", async () => {
  const { service, started } = fixture({ published: new Error("offline") });
  const status = await service.status();
  assert.equal(status.latestVersion, null);
  assert.equal(status.versionsChecked, false);
  await assert.rejects(service.start({ version: "0.1.0-rc8" }), {
    code: "CHART_REGISTRY_UNAVAILABLE",
  });
  assert.deepEqual(started, []);
});
