/**
 * Who and what the current work belongs to. Only server code sets it, from verified identities and
 * owned records, so every record Everything exports carries an owner nobody else can claim.
 */
export interface TelemetryScope {
  readonly ownerId: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  /** The teammate's main conversation, or one of its private background sessions. */
  readonly sessionKind?: "main" | "fork";
  readonly parentSessionId?: string;
  readonly runId?: string;
  readonly provider?: string;
  readonly model?: string;
}
