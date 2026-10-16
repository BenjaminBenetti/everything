import type {
  ArtifactStatus,
  ArtifactSummary,
} from "@everything/artifact-contracts";

import {
  allApps,
  matchesAppFilters,
  type AppFilters,
} from "./artifact-filters.js";

/** Live pages and running servers lead, followed by starting, failing, stopped, and unpublished apps. */
const statusOrder: Readonly<Record<ArtifactStatus, number>> = {
  live: 0,
  running: 0,
  starting: 1,
  failing: 2,
  stopped: 3,
  unpublished: 4,
};

/** Combine search and filters, then order by state and newest update without mutating cached data. */
export function visibleApps(
  apps: readonly ArtifactSummary[],
  search: string,
  filters: AppFilters = allApps,
): ArtifactSummary[] {
  const term = search.trim().toLocaleLowerCase();
  return apps
    .filter(
      (app) =>
        matchesAppFilters(app, filters) &&
        `${app.title} ${app.description} ${app.slug}`
          .toLocaleLowerCase()
          .includes(term),
    )
    .sort(
      (a, b) =>
        statusOrder[a.status] - statusOrder[b.status] ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}

/** Plain-language label for what a viewer would see now. */
export const statusLabels: Readonly<Record<ArtifactStatus, string>> = {
  unpublished: "Not published yet",
  live: "Live",
  running: "Running",
  starting: "Starting",
  failing: "Not working",
  stopped: "Stopped",
};

/** Whether opening the artifact would show its content. */
export function isViewable(status: ArtifactStatus): boolean {
  return status === "live" || status === "running" || status === "starting";
}

/** Units for relative times, largest first. */
const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** Describe a past time relative to now, such as "2 hours ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const elapsed = now - Date.parse(iso);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units)
    if (elapsed >= size)
      return format.format(-Math.floor(elapsed / size), unit);
  return "just now";
}
