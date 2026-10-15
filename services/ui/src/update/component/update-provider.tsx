import { createContext, useContext, type ReactNode } from "react";
import type { UpdateClient } from "../interface/update-client.js";

const UpdateContext = createContext<UpdateClient | null>(null);

/** Supply update capabilities independently of transport and page presentation. */
export function UpdateProvider({
  client,
  children,
}: {
  client: UpdateClient;
  children: ReactNode;
}) {
  return (
    <UpdateContext.Provider value={client}>{children}</UpdateContext.Provider>
  );
}

/** Resolve the update adapter assembled at the application boundary. */
export function useUpdateClient(): UpdateClient {
  const client = useContext(UpdateContext);
  if (!client) throw new Error("UpdateProvider is required");
  return client;
}
