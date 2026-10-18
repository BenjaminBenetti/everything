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

/** Longest command excerpt repeated in a completion event. */
const commandExcerptLength = 2000;

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

/** Keep the start and, mostly, the end of `text` within `limit` characters, marking the omission. */
export function clipMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = (omitted: number) => `\n[… ${omitted} characters omitted …]\n`;
  const available = Math.max(limit - marker(text.length).length, 0);
  const head = safeEnd(text, Math.floor(available / 4));
  const tail = safeStart(text, text.length - (available - head));
  return `${text.slice(0, head)}${marker(tail - head)}${text.slice(tail)}`;
}

/** Fence text so no backtick run inside it, or in the unshortened `source`, can close the block. */
function fenced(text: string, source = text): string {
  const longest = Math.max(
    0,
    ...(source.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** Describe the outcome in one plain sentence. */
function describe(outcome: MonitorOutcome): string {
  switch (outcome.status) {
    case "exited":
      if (outcome.signal) return `Ended by signal ${outcome.signal}.`;
      return outcome.exitCode === 0
        ? "Succeeded with exit code 0."
        : `Failed with exit code ${outcome.exitCode}.`;
    case "timed-out":
      return `Timed out and was stopped. ${outcome.reason ?? ""}`.trim();
    case "cancelled":
      return `Stopped before finishing. ${outcome.reason ?? ""}`.trim();
    case "failed":
      return `Could not start. ${outcome.reason ?? ""}`.trim();
    case "lost":
      return `Result unknown. ${outcome.reason}`;
    case "running":
      return "Still running.";
  }
}

/**
 * Write a self-contained wakeup task for a finished monitor, within the wakeup endpoint's task limit.
 * The command, instructions, and output are fenced so their content cannot change the task's
 * structure, and output is shortened in the middle, never splitting a character, when space runs out.
 */
export function monitorNotification(
  context: MonitorContext,
  outcome: MonitorOutcome,
  maxLength: number = messageTextMaxLength,
): string {
  const reported = outcome.status === "lost" ? undefined : outcome;
  const details = [
    `Monitor: ${context.id}`,
    `Started by: ${context.origin === "main" ? "main" : `fork ${context.origin}`}`,
    `Outcome: ${describe(outcome)}`,
    `Exit code: ${reported?.exitCode ?? "none"}; signal: ${reported?.signal ?? "none"}`,
    `Working directory: ${context.cwd ?? "your workspace"}; timeout: ${context.timeoutSeconds} seconds`,
    `Started at ${context.startedAt}; finished at ${outcome.finishedAt ?? "unknown"}`,
    reported
      ? `Output: ${reported.outputBytes} bytes${reported.truncated ? ", shortened in the middle" : ""}. Full log: ${context.log}${reported.logTruncated ? " (stops at its size limit)" : ""}; read it with file_read.`
      : `Output: unavailable. Any output written before this happened is in ${context.log}.`,
  ];
  const output = reported?.output ?? "";
  const sections = (shortened: string) =>
    [
      "A command you started with the monitor tool has finished. You are handling this completion event in a temporary background session with fresh context, so everything known about the command is below. Your final reply is sent privately to main.",
      details.join("\n"),
      ...(context.instructions
        ? [
            `Instructions given when the monitor started:\n${fenced(context.instructions)}`,
          ]
        : []),
      `Command:\n${fenced(clipMiddle(context.command, commandExcerptLength))}`,
      ...(reported ? [`Output:\n${fenced(shortened, output)}`] : []),
      "Act on the result as the instructions describe. Tell main what matters, such as a failure or the result it was waiting for, and keep it short.",
    ].join("\n\n");
  // The output's fence is sized from the complete output, so the overhead is exact.
  const overhead = sections("").length;
  return sections(clipMiddle(output, Math.max(maxLength - overhead, 0)));
}
