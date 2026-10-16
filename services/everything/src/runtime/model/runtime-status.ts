import type { RuntimeStatus } from "@everything/conversation-contracts";
export type { RuntimeStatus } from "@everything/conversation-contracts";

/** Status of an agent whose runtime has not been loaded in this process. */
export const unloadedRuntimeStatus: RuntimeStatus = Object.freeze({
  status: "idle",
  compacting: false,
  compactionStartedAt: null,
  typing: false,
  backgroundCount: 0,
  sessionId: null,
  runId: null,
  error: null,
});
