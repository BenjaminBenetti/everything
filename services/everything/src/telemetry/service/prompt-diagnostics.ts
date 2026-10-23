import { context, createContextKey, type Context } from "@opentelemetry/api";
import type { ProviderResponseRecord } from "../model/model-failure.js";

/** Where a prompt's provider responses are collected in OpenTelemetry's context. */
const diagnosticsKey = createContextKey(
  "everything.telemetry.prompt-diagnostics",
);

/**
 * What the provider answered during one model prompt, so a failure the model runtime later reduces
 * to a generic error can still be explained with the status, provider code, request ID, and number
 * of attempts of the request that failed. Holds no request or response content.
 */
export class PromptDiagnostics {
  // ===========================================
  // State
  // ===========================================

  private attemptCount = 0;
  private current: ProviderAttempt | undefined;
  private response: ProviderResponseRecord | undefined;

  // ===========================================
  // Recording
  // ===========================================

  /** A new model request is starting; its SDK may retry, each retry being another attempt. */
  beginRequest(): void {
    this.attemptCount = 0;
    this.current = undefined;
    this.response = undefined;
  }

  /**
   * Start the next HTTP attempt of the current request. An earlier attempt's response no longer
   * explains the request, so a failure before this attempt receives a response is diagnosed from
   * the failure itself; each attempt's own span keeps its response.
   */
  nextAttempt(): ProviderAttempt {
    this.current = { number: ++this.attemptCount };
    this.response = undefined;
    return this.current;
  }

  /**
   * Keep `attempt`'s response if it is still the latest attempt. Responses are read
   * asynchronously, so one that arrives after a later attempt or request has started is ignored.
   */
  record(attempt: ProviderAttempt, response: ProviderResponseRecord): void {
    if (attempt === this.current) this.response = response;
  }

  // ===========================================
  // Reading
  // ===========================================

  /** HTTP attempts the current request has made. */
  get attempts(): number {
    return this.attemptCount;
  }

  /** The response to the current request's latest attempt, if that attempt received one. */
  get lastResponse(): ProviderResponseRecord | undefined {
    return this.response;
  }
}

/** One HTTP attempt of a model request, numbered from 1. */
export interface ProviderAttempt {
  readonly number: number;
}

/** A context whose provider requests report to `diagnostics`. */
export function withPromptDiagnostics(
  diagnostics: PromptDiagnostics,
  current: Context = context.active(),
): Context {
  return current.setValue(diagnosticsKey, diagnostics);
}

/** The diagnostics of the prompt the current work belongs to, if any. */
export function promptDiagnostics(
  current: Context = context.active(),
): PromptDiagnostics | undefined {
  return current.getValue(diagnosticsKey) as PromptDiagnostics | undefined;
}
