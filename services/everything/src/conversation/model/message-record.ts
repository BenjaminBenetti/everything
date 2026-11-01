import type { AgentDefinition } from "../../agent/model/agent.js";
import type { AttachmentRecord } from "../../attachment/model/attachment.js";
import type { ConversationMessage } from "./message.js";

/** Internal ORM relation/ordering fields, excluded from chat responses. */
export interface MessageRecord extends Omit<
  ConversationMessage,
  "attachments"
> {
  readonly agentId: string;
  readonly agent?: AgentDefinition;
  /** Loaded with history; absent when a query doesn't need them. */
  readonly attachments?: AttachmentRecord[];
  /** Insertion order; PostgreSQL bigint values are mapped to strings. */
  readonly sequence: string;
}
