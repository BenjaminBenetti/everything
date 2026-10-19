import { messageTextMaxLength } from "@everything/conversation-contracts";
import type { MonitorResult } from "@everything/workspace-contracts/monitor";

/** What the monitor was started with, recorded by Everything rather than reported by the pod. */
export interface MonitorContext {
  readonly id: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly instructions: string | null;
  readonly origin: string;
  readonly timeoutSeconds: number;
  readonly startedAt: string;
  readonly log: string;
}

/** A monitor whose pod could no longer report it, so its outcome is unknown. */
export interface LostMonitor {
  readonly status: "lost";
  readonly reason: string;
  readonly finishedAt: string;
}

/** How a monitor ended, as reported by its pod or as lost. */
export type MonitorOutcome = MonitorResult | LostMonitor;

/** Longest excerpts of the fenced command and instructions repeated in a completion event. */
const commandExcerptLength = 2000;
const instructionsExcerptLength = 2000;

/** Longest single-line value, such as a path or reason, repeated in a completion event. */
const valueExcerptLength = 500;

/** Longest backtick run kept intact inside a fence, which bounds every fence's length. */
const backtickRunMaxLength = 15;

/** Never end a slice between the two halves of a surrogate pair. */
function safeEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  return end > 0 && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/** Never start a slice on the second half of a surrogate pair. */
function safeStart(text: string, start: number): number {
  const code = text.charCodeAt(start);
  return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
}

/**
 * Keep the start and, mostly, the end of `text` within `limit` characters, marking the omission.
 * Below the marker's length only the start is kept, so the result never exceeds `limit`.
 */
export function clipMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = (omitted: number) => `\n[… ${omitted} characters omitted …]\n`;
  const available = limit - marker(text.length).length;
  if (available <= 0) return text.slice(0, safeEnd(text, Math.max(limit, 0)));
  const head = safeEnd(text, Math.floor(available / 4));
  const tail = safeStart(text, text.length - (available - head));
  return `${text.slice(0, head)}${marker(tail - head)}${text.slice(tail)}`;
}

/** Split backtick runs longer than the fence limit with zero-width spaces. */
function splitBacktickRuns(text: string): string {
  return text.replace(
    new RegExp(`\`{${backtickRunMaxLength + 1},}`, "g"),
    (run) =>
      run.replace(
        new RegExp(`\`{${backtickRunMaxLength}}(?=\`)`, "g"),
        "$&\u200b",
      ),
  );
}

/** Shorten a value and keep it on one line, so it cannot add lines to the event's details. */
function value(text: string): string {
  return splitBacktickRuns(clipMiddle(text, valueExcerptLength)).replace(
    /[\r\n\v\f\u0085\u2028\u2029]+/g,
    " ",
  );
}

/** Fence text so no backtick run inside it can close the block; the fence never exceeds the run limit. */
function fenced(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce(
    (most, run) => Math.max(most, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** Describe the outcome in one plain sentence. */
function describe(outcome: MonitorOutcome): string {
  switch (outcome.status) {
    case "exited":
      if (outcome.signal) return `Ended by signal ${value(outcome.signal)}.`;
      return outcome.exitCode === 0
        ? "Succeeded with exit code 0."
        : `Failed with exit code ${outcome.exitCode}.`;
    case "timed-out":
      return `Timed out and was stopped. ${value(outcome.reason ?? "")}`.trim();
    case "cancelled":
      return `Stopped before finishing. ${value(outcome.reason ?? "")}`.trim();
    case "failed":
      return `Could not start. ${value(outcome.reason ?? "")}`.trim();
    case "lost":
      return `Result unknown. ${value(outcome.reason)}`;
    case "running":
      return "Still running.";
  }
}

/**
 * Write a self-contained wakeup task for a finished monitor, never longer than `maxLength`.
 * Every variable field is shortened to a fixed excerpt, and backtick runs longer than the fence limit
 * are split, so the overhead around the output is bounded and the output receives the remaining space.
 * The command, instructions, and output are fenced so their content cannot change the task's structure,
 * and nothing is shortened between the two halves of a character.
 */
export function monitorNotification(
  context: MonitorContext,
  outcome: MonitorOutcome,
  maxLength: number = messageTextMaxLength,
): string {
  const reported = outcome.status === "lost" ? undefined : outcome;
  const log = value(context.log);
  const details = [
    `Monitor: ${value(context.id)}`,
    `Started by: ${context.origin === "main" ? "main" : `fork ${value(context.origin)}`}`,
    `Outcome: ${describe(outcome)}`,
    `Exit code: ${reported?.exitCode ?? "none"}; signal: ${value(reported?.signal ?? "none")}`,
    `Working directory: ${context.cwd === null ? "your workspace" : value(context.cwd)}; timeout: ${context.timeoutSeconds} seconds`,
    `Started at ${value(context.startedAt)}; finished at ${value(outcome.finishedAt ?? "unknown")}`,
    reported
      ? `Output: ${reported.outputBytes} bytes${reported.truncated ? ", shortened in the middle" : ""}. Full log: ${log}${reported.logTruncated ? " (stops at its size limit)" : ""}; read it with file_read.`
      : `Output: unavailable. Any output written before this happened is in ${log}.`,
  ];
  const command = splitBacktickRuns(
    clipMiddle(context.command, commandExcerptLength),
  );
  const instructions =
    context.instructions &&
    splitBacktickRuns(
      clipMiddle(context.instructions, instructionsExcerptLength),
    );
  const output = splitBacktickRuns(reported?.output ?? "");
  const split = [details.join("\n"), command, instructions ?? "", output].some(
    (text) => text.includes("`\u200b`"),
  );
  // Shortening only removes text, so the output's fence never grows and the overhead below is exact.
  const fence = fenced(output);
  const outputFence = fence.slice(0, fence.indexOf("\n"));
  const sections = (shortened: string) =>
    [
      "A command you started with the monitor tool has finished. You are handling this completion event in a temporary background session with fresh context, so everything known about the command is below. Your final reply is sent privately to main.",
      details.join("\n"),
      ...(instructions
        ? [
            `Instructions given when the monitor started:\n${fenced(instructions)}`,
          ]
        : []),
      `Command:\n${fenced(command)}`,
      ...(reported
        ? [`Output:\n${outputFence}\n${shortened}\n${outputFence}`]
        : []),
      ...(split
        ? [
            `Backtick runs longer than ${backtickRunMaxLength} were split with zero-width spaces to keep the sections above intact.`,
          ]
        : []),
      "Act on the result as the instructions describe. Tell main what matters, such as a failure or the result it was waiting for, and keep it short.",
    ].join("\n\n");
  const overhead = sections("").length;
  const task = sections(clipMiddle(output, maxLength - overhead));
  // Only a limit smaller than the fixed overhead reaches this; shorten the whole task as a last resort.
  return clipMiddle(task, maxLength);
}
