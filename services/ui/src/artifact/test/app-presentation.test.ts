import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactSummary } from "@everything/artifact-contracts";
import { visibleApps } from "../model/artifact-presentation.js";

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
    status,
    updatedAt: `2026-10-${day}T10:00:00Z`,
  } as ArtifactSummary;
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
