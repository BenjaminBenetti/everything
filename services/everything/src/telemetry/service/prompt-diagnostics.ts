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
  private response: ProviderResponseRecord | undefined;

  // ===========================================
  // Recording
  // ===========================================

  /** A new model request is starting; its SDK may retry, each retry being another attempt. */
  beginRequest(): void {
    this.attemptCount = 0;
    this.response = undefined;
  }

  /** Number the next HTTP attempt of the current request. */
  nextAttempt(): number {
    return ++this.attemptCount;
  }

  /** Keep the latest response of the current request. */
  record(response: ProviderResponseRecord): void {
    this.response = response;
  }

  // ===========================================
  // Reading
  // ===========================================

  /** HTTP attempts the current request has made. */
  get attempts(): number {
    return this.attemptCount;
  }

  /** The current request's latest response, if it received one. */
  get lastResponse(): ProviderResponseRecord | undefined {
    return this.response;
  }
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
