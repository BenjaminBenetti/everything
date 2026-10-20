import type { RuntimeStatus } from "@everything/conversation-contracts";

/** The parts of the conversation's status query that show what its main teammate is doing. */
export interface MainActivitySnapshot {
  readonly isSuccess: boolean;
  /** False while only a cached result from an earlier visit is available. */
  readonly isFetchedAfterMount: boolean;
  readonly data?:
    | {
        readonly runtime: Pick<RuntimeStatus, "mainRunning" | "monitorCount">;
      }
    | undefined;
}

/** What the main teammate's avatar shows, in priority order: thinking, watching monitors, or resting. */
export type MainActivity =
  | { readonly kind: "thinking" }
  | { readonly kind: "watching"; readonly monitors: number }
  | { readonly kind: "idle" };

const idle: MainActivity = { kind: "idle" };

/**
 * Trust only a successful status read made since the conversation opened. The main session's own work
 * shows thinking even while monitors run; otherwise its running monitors show watching. Background
 * teammates, a cached earlier visit, a failed refresh awaiting reconnection, and an older API without
 * these fields all leave the ordinary avatar.
 */
export function mainTeammateActivity(
  snapshot: MainActivitySnapshot,
): MainActivity {
  if (!snapshot.isSuccess || !snapshot.isFetchedAfterMount || !snapshot.data)
    return idle;
  const { mainRunning, monitorCount } = snapshot.data.runtime;
  if (mainRunning === true) return { kind: "thinking" };
  return Number.isInteger(monitorCount) && monitorCount > 0
    ? { kind: "watching", monitors: monitorCount }
    : idle;
}

/** Name a number of monitors, such as "1 monitor" or "3 monitors". */
export function monitorCountPhrase(count: number): string {
  return `${count} ${count === 1 ? "monitor" : "monitors"}`;
}

/** The watching avatar's tooltip, such as "1 monitor running" or "3 monitors running". */
export function monitorCountLabel(count: number): string {
  return `${monitorCountPhrase(count)} running`;
}

/** What screen readers hear once when the activity changes; nothing while the teammate rests. */
export function mainActivityStatus(
  name: string,
  activity: MainActivity,
): string {
  switch (activity.kind) {
    case "thinking":
      return `${name} is working`;
    case "watching":
      return `${name} is watching ${monitorCountPhrase(activity.monitors)}`;
    case "idle":
      return "";
  }
}
