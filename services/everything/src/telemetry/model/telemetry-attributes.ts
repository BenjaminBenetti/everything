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
  /** The message a teammate turn answered, as a bounded, redacted preview. */
  messagePreview: "everything.message_preview",
  /** Characters in the whole message the preview was made from. */
  messageLength: "everything.message_length",
  /** The message preview leaves part of the message out. */
  messageTruncated: "everything.message_truncated",
  /** A tool call's arguments, as bounded, redacted JSON. */
  toolArguments: "everything.tool_arguments",
  /** The arguments preview cut or summarized part of the arguments. */
  toolArgumentsTruncated: "everything.tool_arguments_truncated",
  /** Set on spans whose content previews were left out because the installation does not record them. */
  contentWithheld: "everything.content_withheld",
  /** Where a prompt's text came from, one of `promptSources`; never the text itself. */
  promptSource: "everything.prompt_source",
  httpMethod: "http.request.method",
  httpRoute: "http.route",
  httpStatus: "http.response.status_code",
  serverAddress: "server.address",
  urlPath: "url.path",
  urlFull: "url.full",
  /** A database query's statement, with placeholders for its parameters, as PostgreSQL's instrumentation records it. */
  dbQueryText: "db.query.text",
  /** The same under older semantic conventions. */
  dbStatement: "db.statement",
} as const;

/** Longest attribute value the SDK keeps, in UTF-16 code units; it cuts longer values when set. */
export const attributeValueLengthLimit = 2_048;

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

/**
 * Where a teammate prompt's text came from: the message sent to the conversation, a reminder
 * Everything adds when a turn hasn't replied, or a private message from other work, such as a
 * background fork, a monitor, or an API event.
 */
export const promptSources = ["message", "reminder", "private"] as const;
export type PromptSource = (typeof promptSources)[number];

/** Names of the spans Everything starts itself; instrumented libraries name their own. */
export const telemetrySpans = {
  turn: "teammate.turn",
  prompt: "teammate.prompt",
  tool: "teammate.tool",
  compaction: "teammate.compaction",
  providerRequest: "provider.request",
} as const;
