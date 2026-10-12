import type {
  MessagePage,
  MessageReceipt,
  RuntimeStatus,
} from "@everything/conversation-contracts";

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
  /** Save input and begin a turn using the teammate's saved model settings. */
  send(agentId: string, text: string): Promise<MessageReceipt>;
  /** Stop the active reply while retaining all saved messages. */
  interrupt(agentId: string): Promise<RuntimeStatus>;
}
