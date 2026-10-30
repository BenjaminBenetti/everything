import { createContext, useContext, type ReactNode } from "react";
import type { AttachmentClient } from "../interface/attachment-client.js";
import type { ConversationClient } from "../interface/conversation-client.js";

const ConversationContext = createContext<ConversationClient | null>(null);
const AttachmentContext = createContext<AttachmentClient | null>(null);

/** Supply conversation and attachment capabilities independently of transport and page presentation. */
export function ConversationProvider({
  client,
  attachments,
  children,
}: {
  client: ConversationClient;
  attachments: AttachmentClient;
  children: ReactNode;
}) {
  return (
    <ConversationContext.Provider value={client}>
      <AttachmentContext.Provider value={attachments}>
        {children}
      </AttachmentContext.Provider>
    </ConversationContext.Provider>
  );
}

/** Resolve the conversation adapter assembled at the application boundary. */
export function useConversationClient(): ConversationClient {
  const client = useContext(ConversationContext);
  if (!client) throw new Error("ConversationProvider is required");
  return client;
}

/** Resolve the attachment adapter assembled at the application boundary. */
export function useAttachmentClient(): AttachmentClient {
  const client = useContext(AttachmentContext);
  if (!client) throw new Error("ConversationProvider is required");
  return client;
}
