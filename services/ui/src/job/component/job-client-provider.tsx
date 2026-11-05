import { createContext, useContext, type ReactNode } from "react";
import type { JobClient } from "../interface/job-client.js";

const JobContext = createContext<JobClient | null>(null);

/** Supply job capabilities independently of transport and page presentation. */
export function JobClientProvider({
  client,
  children,
}: {
  client: JobClient;
  children: ReactNode;
}) {
  return <JobContext.Provider value={client}>{children}</JobContext.Provider>;
}

/** Resolve the job adapter assembled at the application boundary. */
export function useJobClient(): JobClient {
  const client = useContext(JobContext);
  if (!client) throw new Error("JobClientProvider is required");
  return client;
}
