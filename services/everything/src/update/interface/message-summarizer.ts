import type { MessageSummaryInput } from "../model/message-summary.js";

/** Summarize one explicitly delivered message, without tools, private context, or conversation writes. */
export interface MessageSummarizer {
  summarize(message: MessageSummaryInput, signal: AbortSignal): Promise<string>;
}
