import type { RuntimeStatus } from "../../runtime/model/runtime-status.js";
import type { MessagePage, MessageReceipt } from "../model/message.js";
import type { SendMessageBody } from "../schema/message-request.js";

/** Conversation use cases for an agent owned by the authenticated subject. */
export interface ConversationOperations {
  /** Read the visible conversation after enforcing ownership. */
  list(ownerId: string, agentId: string, before?: string): Promise<MessagePage>;
  /** Persist user input with its attachments and schedule an interruptible main-agent turn. */
  send(
    ownerId: string,
    agentId: string,
    input: SendMessageBody,
  ): Promise<MessageReceipt>;
  /** Read public execution status. */
  status(ownerId: string, agentId: string): Promise<RuntimeStatus>;
  /** Interrupt the current turn and retain the conversation. */
  interrupt(ownerId: string, agentId: string): Promise<void>;
}
