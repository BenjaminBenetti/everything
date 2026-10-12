import type {
  ArtifactKind,
  ArtifactStatus,
} from "@everything/artifact-contracts";

/** Plain-language label for each kind of artifact. */
export const kindLabels: Readonly<Record<ArtifactKind, string>> = {
  static: "Page",
  dynamic: "App",
};

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
