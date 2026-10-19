import type { RuntimeStatus } from "@everything/conversation-contracts";
export type { RuntimeStatus } from "@everything/conversation-contracts";

/** What a loaded session reports; the conversation service adds the teammate's monitors. */
export type SessionRuntimeStatus = Omit<RuntimeStatus, "monitorCount">;

/** Status of an agent whose runtime has not been loaded in this process. */
export const unloadedRuntimeStatus: RuntimeStatus = Object.freeze({
  status: "idle",
  mainRunning: false,
  compacting: false,
  compactionStartedAt: null,
  typing: false,
  backgroundCount: 0,
  monitorCount: 0,
  sessionId: null,
  runId: null,
  error: null,
});
