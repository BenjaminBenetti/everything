import type { StoredSummaryStatus } from "../../update/model/message-summary.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ConversationMessage } from "./message.js";

/** Internal ORM relation/ordering fields, excluded from chat responses. */
export interface MessageRecord extends ConversationMessage {
  readonly agentId: string;
  readonly agent?: AgentDefinition;
  /** Insertion order; PostgreSQL bigint values are mapped to strings. */
  readonly sequence: string;
  /** The first explicit receipt, or null until the owner has seen this message. */
  readonly readAt: string | null;
  readonly updateSummary: string | null;
  readonly summaryStatus: StoredSummaryStatus;
  readonly summaryStartedAt: string | null;
}
