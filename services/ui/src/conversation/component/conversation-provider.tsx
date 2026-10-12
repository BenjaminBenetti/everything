import { createContext, useContext, type ReactNode } from "react";
import type { ConversationClient } from "../interface/conversation-client.js";

const ConversationContext = createContext<ConversationClient | null>(null);

/** Supply conversation capabilities independently of transport and page presentation. */
export function ConversationProvider({
  client,
  children,
}: {
  client: ConversationClient;
  children: ReactNode;
}) {
  return (
    <ConversationContext.Provider value={client}>
      {children}
    </ConversationContext.Provider>
  );
}

/** Resolve the conversation adapter assembled at the application boundary. */
export function useConversationClient(): ConversationClient {
  const client = useContext(ConversationContext);
  if (!client) throw new Error("ConversationProvider is required");
  return client;
}
