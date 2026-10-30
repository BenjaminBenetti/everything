import type {
  MessagePage,
  MessageReceipt,
  RuntimeStatus,
} from "@everything/conversation-contracts";

/** What the user sends: text, uploaded files, or both. */
export interface MessageInput {
  readonly text?: string;
  readonly attachmentIds?: readonly string[];
}

/** Browser capabilities for the one conversation belonging to a teammate. */
export interface ConversationClient {
  /** Read recent messages or an older page without starting work. */
  history(
    agentId: string,
    before?: string,
    signal?: AbortSignal,
  ): Promise<MessagePage>;
  /** Read safe progress independently of private model output. */
  status(agentId: string, signal?: AbortSignal): Promise<RuntimeStatus>;
  /** Save input and its attached files, and begin a turn using the teammate's saved model settings. */
  send(agentId: string, input: MessageInput): Promise<MessageReceipt>;
  /** Acknowledge exact messages received in the open chat or read from older history. */
  read(agentId: string, messageIds: readonly string[]): Promise<void>;
}
