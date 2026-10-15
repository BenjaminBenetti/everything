import type { UpdateSummaryInput } from "../model/update-summary.js";

/** Summarize one update's source, without tools, private context, or conversation writes. */
export interface UpdateSummarizer {
  summarize(update: UpdateSummaryInput, signal: AbortSignal): Promise<string>;
}
