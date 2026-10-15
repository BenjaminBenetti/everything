import type {
  MessagePage,
  MessageReceipt,
  RuntimeStatus,
} from "@everything/conversation-contracts";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import type { ConversationClient } from "../interface/conversation-client.js";

/** Map the conversation interface to authenticated teammate-scoped endpoints. */
export class HttpConversationClient implements ConversationClient {
  // ===========================================
  // Construction
  // ===========================================

  /** Share the application's cookie and error handling policy. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Retry-safe receipt for exact messages, never a cursor covering unseen gaps. */
  read(agentId: string, messageIds: readonly string[]): Promise<void> {
    return this.transport.request(
      `/v1/agents/${encodeURIComponent(agentId)}/messages/read`,
      {
        method: "POST",
        body: JSON.stringify({ messageIds }),
      },
    );
  }

  /** Use opaque message IDs to retrieve older history without offsets. */
  history(
    agentId: string,
    before?: string,
    signal?: AbortSignal,
  ): Promise<MessagePage> {
    const query = before ? `?${new URLSearchParams({ before })}` : "";
    return this.transport.request(
      `/v1/agents/${encodeURIComponent(agentId)}/messages${query}`,
      signal ? { signal } : {},
    );
  }

  /** Read progress without creating or switching model sessions. */
  status(agentId: string, signal?: AbortSignal): Promise<RuntimeStatus> {
    return this.transport.request(
      `/v1/agents/${encodeURIComponent(agentId)}/runtime`,
      signal ? { signal } : {},
    );
  }

  /** Accept one deliberate submission; never automatically retry a POST. */
  send(agentId: string, text: string): Promise<MessageReceipt> {
    return this.transport.request(
      `/v1/agents/${encodeURIComponent(agentId)}/messages`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
  }
}
