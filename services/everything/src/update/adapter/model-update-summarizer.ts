import type { InferenceRuntimeFactory } from "../../runtime/interface/inference-runtime.js";
import type { UpdateSummarizer } from "../interface/update-summarizer.js";
import {
  summaryMaxTokens,
  summaryTimeoutMs,
  type UpdateSummaryInput,
} from "../model/update-summary.js";
import { updateSummaryPrompts } from "../prompt/update-summary-prompt.js";
import { clampSummary, unwrapQuotes } from "../service/summary-text.js";

/** Make a standalone inference request through the existing owner-scoped provider adapter. */
export class ModelUpdateSummarizer implements UpdateSummarizer {
  // ===========================================
  // Construction
  // ===========================================

  /** Share provider access and model validation, never a teammate's live session. */
  constructor(private readonly inference: InferenceRuntimeFactory) {}

  // ===========================================
  // Inference
  // ===========================================

  /** Send only the update's source text, with no tools, history, or automatic request retries. */
  async summarize(
    update: UpdateSummaryInput,
    signal: AbortSignal,
  ): Promise<string> {
    if (!update.inference) throw new Error("No summary model is configured");
    signal.throwIfAborted();
    // Background summaries don't explicitly request the teammate's Fast mode.
    const { speed: _speed, ...selection } = update.inference;
    const { models, model } = await this.inference.create(
      update.ownerId,
      selection,
    );
    signal.throwIfAborted();
    const response = await models.completeSimple(
      model,
      {
        systemPrompt: updateSummaryPrompts[update.kind],
        messages: [
          { role: "user", content: update.text, timestamp: Date.now() },
        ],
      },
      {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(summaryTimeoutMs),
        ]),
        maxTokens: Math.min(model.maxTokens, summaryMaxTokens),
        reasoning: "minimal",
        maxRetries: 0,
      },
    );
    if (
      response.stopReason !== "stop" ||
      response.content.some((block) => block.type === "toolCall")
    )
      throw new Error("Summary generation did not complete");
    const summary = clampSummary(
      unwrapQuotes(
        response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
      ),
    );
    if (!summary) throw new Error("Summary generation returned no text");
    return summary;
  }
}
