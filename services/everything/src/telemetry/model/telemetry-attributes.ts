/**
 * Attributes Everything writes on its spans and events. Telemetry storage keeps each as a column
 * named with its dots replaced by underscores; see `telemetryColumn`.
 */
export const telemetryAttributes = {
  event: "everything.event",
  eventId: "everything.event_id",
  ownerId: "everything.owner_id",
  agentId: "everything.agent_id",
  sessionId: "everything.session_id",
  sessionKind: "everything.session_kind",
  parentSessionId: "everything.parent_session_id",
  runId: "everything.run_id",
  type: "everything.type",
  severity: "everything.severity",
  outcome: "everything.outcome",
  category: "everything.category",
  code: "everything.code",
  message: "everything.message",
  provider: "everything.provider",
  model: "everything.model",
  api: "everything.api",
  requestId: "everything.request_id",
  retryable: "everything.retryable",
  attempt: "everything.attempt",
  attempts: "everything.attempts",
  stopReason: "everything.stop_reason",
  reason: "everything.reason",
  tool: "everything.tool",
  errorType: "everything.error_type",
  causes: "everything.causes",
  stack: "everything.stack",
  retryAfter: "everything.retry_after",
  speed: "everything.speed",
  willRetry: "everything.will_retry",
  /** Set on records whose error text was left out because the installation does not record it. */
  textWithheld: "everything.text_withheld",
  httpMethod: "http.request.method",
  httpRoute: "http.route",
  httpStatus: "http.response.status_code",
  serverAddress: "server.address",
  urlPath: "url.path",
  urlFull: "url.full",
} as const;

/** The column telemetry storage keeps an attribute in. */
export function telemetryColumn(attribute: string): string {
  return attribute.replaceAll(".", "_");
}

/** Names of the events Everything records, each with its own fixed title. */
export const telemetryEvents = {
  modelFailed: "model.request.failed",
  modelCancelled: "model.request.cancelled",
  turnFailed: "turn.failed",
  turnCancelled: "turn.cancelled",
  compactionFailed: "compaction.failed",
  compactionCancelled: "compaction.cancelled",
  requestFailed: "http.request.failed",
  warning: "app.warning",
} as const;

/** Names of the spans Everything starts itself; instrumented libraries name their own. */
export const telemetrySpans = {
  turn: "teammate.turn",
  prompt: "teammate.prompt",
  tool: "teammate.tool",
  compaction: "teammate.compaction",
  providerRequest: "provider.request",
} as const;
