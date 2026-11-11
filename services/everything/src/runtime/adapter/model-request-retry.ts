import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentSession as PiSession,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelFailureCategory } from "../../telemetry/model/model-failure.js";
import { classifyModelFailure } from "../../telemetry/service/model-failure-classifier.js";
import type { ModelRetryPolicy } from "../model/model-retry-policy.js";
import { speedReport } from "../model/speed-report.js";

/** An event a Pi session reports while it works. */
type PiSessionEvent = Parameters<Parameters<PiSession["subscribe"]>[0]>[0];

/** What became of a model response that failed or was stopped. */
export interface ModelResponseOutcome {
  /** Which attempt of its model request the response was, counting from 1. */
  readonly attempt: number;
  /** Whether the same request is sent again. */
  readonly willRetry: boolean;
  /** Whether it ended because its prompt was stopped, which is a cancellation, not a failure. */
  readonly stopped: boolean;
}

/** Where a prompt may retry its requests: the session's Pi settings and the policy to apply. */
export interface ModelRetryControl {
  readonly settings: SettingsManager;
  readonly policy: ModelRetryPolicy;
  /** The context window of the session's model, which tells an overflow apart. */
  readonly contextWindow: () => number;
}

/** Failures the same request may get past when it is sent again shortly. */
const transientCategories = new Set<ModelFailureCategory>([
  "stream_interrupted",
  "overloaded",
  "unavailable",
  "server_error",
  "timeout",
  "network",
  "rate_limit",
]);

/** How a request that its prompt's own stop aborted reads when it ends as an error. */
const abortWording = /\b(?:operation|request) was aborted\b|\bAbortError\b/i;

/**
 * Whether a failed response's request may be sent again unchanged: a passing failure by the
 * existing diagnosis, which Pi's own retry rule accepts too. A refused or limited Fast mode request
 * keeps its own recovery, a context overflow is left to compaction, and a quota, credential, or
 * invalid request fails at once.
 */
export function transientModelFailure(
  message: AssistantMessage,
  contextWindow: number,
): boolean {
  if (message.stopReason !== "error" || speedReport(message)?.failure)
    return false;
  if (
    !isRetryableAssistantError(message) ||
    isContextOverflow(message, contextWindow)
  )
    return false;
  const { category } = classifyModelFailure({
    stopReason: "error",
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
  });
  return transientCategories.has(category);
}

/**
 * One prompt's retries of model requests that fail for a passing reason, through Pi's own retry.
 * Pi repeats only the request that failed: it leaves the failed response out of what the model is
 * sent next and continues from the turn's last message, so the prompt is not sent twice, earlier
 * tool calls do not run again, and a call in a failed response never runs. Pi's own rule for which
 * failures to retry is broader, including limits that have their own recovery, so Pi's retry stays
 * off and is allowed for one failed response at a time, when `transientModelFailure` accepts it and
 * the prompt has not been stopped. It is off again once Pi has scheduled or ended that retry, and
 * when the prompt ends. Without a `control`, nothing is retried.
 */
export class ModelRequestRetry {
  // ===========================================
  // State and construction
  // ===========================================

  private retries = 0;
  private readonly outcomes = new WeakMap<object, ModelResponseOutcome>();

  /** Follow one prompt, which `stop` aborts when its turn is stopped or interrupted. */
  constructor(
    private readonly stop: AbortSignal,
    private readonly control?: ModelRetryControl,
  ) {
    this.allow(false);
  }

  // ===========================================
  // Following the prompt
  // ===========================================

  /** Follow one session event; for a response that failed or was stopped, decide what becomes of it. */
  follow(event: PiSessionEvent): ModelResponseOutcome | undefined {
    if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
      this.allow(false);
      return undefined;
    }
    if (event.type !== "message_end" || event.message.role !== "assistant")
      return undefined;
    const message = event.message;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      // A completed response ends its request, so the next request counts afresh, as Pi's does.
      this.retries = 0;
      return undefined;
    }
    const control = this.control;
    const willRetry =
      !this.stop.aborted &&
      control !== undefined &&
      this.retries < control.policy.maxRetries &&
      transientModelFailure(message, control.contextWindow());
    const outcome: ModelResponseOutcome = {
      attempt: this.retries + 1,
      willRetry,
      stopped:
        this.stop.aborted &&
        (message.stopReason === "aborted" ||
          abortWording.test(message.errorMessage ?? "")),
    };
    if (willRetry) this.retries++;
    this.allow(willRetry);
    this.outcomes.set(message, outcome);
    return outcome;
  }

  /** What became of `message`, if it failed or was stopped during this prompt. */
  outcome(message: unknown): ModelResponseOutcome | undefined {
    return typeof message === "object" && message !== null
      ? this.outcomes.get(message)
      : undefined;
  }

  /** Leave Pi's retry off once the prompt has ended. */
  end(): void {
    this.allow(false);
  }

  // ===========================================
  // Pi's retry
  // ===========================================

  /** Allow Pi's retry or not, with the policy's bounds, for the response Pi handles next. */
  private allow(enabled: boolean): void {
    const control = this.control;
    if (!control) return;
    const { maxRetries, baseDelayMs, maxDelayMs } = control.policy;
    control.settings.applyOverrides({
      retry: { enabled, maxRetries, baseDelayMs, maxAgentDelayMs: maxDelayMs },
    });
  }
}
