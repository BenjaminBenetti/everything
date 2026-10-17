import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactSummary } from "@everything/artifact-contracts";
import { visibleApps } from "../model/artifact-presentation.js";
import { allApps, appCreators } from "../model/artifact-filters.js";

/** Build a minimal app summary for search and ordering cases. */
function app(
  id: string,
  status: ArtifactSummary["status"],
  day: number,
  description = "",
): ArtifactSummary {
  return {
    id,
    slug: id,
    title: id,
    description,
    kind: "dynamic",
    database: false,
    capabilities: [],
    createdBy: { id: "ada", name: "Ada" },
    updatedBy: { id: "grace", name: "Grace" },
    url: `https://apps.test/${id}/`,
    release: 1,
    createdAt: "2026-10-01T10:00:00Z",
    status,
    updatedAt: `2026-10-${day}T10:00:00Z`,
  };
}

test("running and live apps lead with newest updates first inside every status group", () => {
  const apps = [
    app("draft", "unpublished", 19),
    app("stopped", "stopped", 19),
    app("older", "running", 11),
    app("newer", "running", 15),
    app("page", "live", 13),
    app("starting", "starting", 17),
    app("failed", "failing", 18),
    app("stopped-older", "stopped", 11),
  ];
  const original = [...apps];
  assert.deepEqual(
    visibleApps(apps, "").map((item) => item.id),
    [
      "newer",
      "page",
      "older",
      "starting",
      "failed",
      "stopped",
      "stopped-older",
      "draft",
    ],
  );
  assert.deepEqual(apps, original);
});

test("search trims whitespace, ignores case, and matches title, slug, and description", () => {
  const apps = [
    {
      ...app("trip-planner", "running", 15, "Weekend itinerary"),
      title: "Holiday",
    },
    app("notes", "stopped", 18),
  ];
  for (const search of [" HOLIDAY ", "TRIP-PLANNER", " itinerary "])
    assert.deepEqual(
      visibleApps(apps, search).map((item) => item.id),
      ["trip-planner"],
    );
  assert.deepEqual(visibleApps(apps, "missing"), []);
});

test("creator, type, capabilities, and search intersect without confusing the updater with the creator", () => {
  const apps: ArtifactSummary[] = [
    {
      ...app("planner", "running", 15),
      database: true,
      capabilities: ["everything-api"],
    },
    {
      ...app("archive", "stopped", 14),
      database: true,
      capabilities: ["everything-api"],
    },
    { ...app("notes", "running", 13), database: true },
    {
      ...app("hooks", "running", 12),
      capabilities: ["everything-api", "api-key"],
      createdBy: { id: "grace", name: "Grace" },
    },
    { ...app("report", "live", 11), kind: "static" },
  ];
  const both = { ...allApps, database: true, api: true };
  assert.deepEqual(
    visibleApps(apps, "", both).map((item) => item.id),
    ["planner", "archive"],
  );
  assert.deepEqual(
    visibleApps(apps, "", { ...allApps, apiKey: true }).map((item) => item.id),
    ["hooks"],
  );
  assert.deepEqual(
    visibleApps(apps, "", { ...both, apiKey: true }).map((item) => item.id),
    [],
  );
  assert.deepEqual(
    visibleApps(apps, "", { ...allApps, creatorId: "grace" }).map(
      (item) => item.id,
    ),
    ["hooks"],
  );
  assert.deepEqual(
    visibleApps(apps, "", { ...allApps, kind: "static" }).map(
      (item) => item.id,
    ),
    ["report"],
  );
  assert.deepEqual(
    visibleApps(apps, "PLAN", {
      ...both,
      creatorId: "ada",
      kind: "dynamic",
    }).map((item) => item.id),
    ["planner"],
  );
  assert.deepEqual(visibleApps(apps, "", { ...both, kind: "static" }), []);
  assert.equal(visibleApps(apps, "", allApps).length, apps.length);
});

test("creator options preserve saved authors when the directory is unavailable and use current avatars when available", () => {
  const apps = [app("first", "live", 10), app("second", "stopped", 11)];
  assert.deepEqual(appCreators(apps), [{ id: "ada", name: "Ada" }]);
  const current = {
    id: "ada",
    name: "Ada Lovelace",
    avatarId: "avatar-03" as const,
    systemPrompt: "Help",
    inference: null,
  };
  assert.deepEqual(appCreators(apps, [current]), [current]);
  assert.deepEqual(appCreators([]), []);
});
