/** Process-local execution status of an agent, safe to return to its owner. */
export interface RuntimeStatus {
  readonly status: "idle" | "running" | "error";
  /** Pi session loaded in this process; null until the agent's first turn after startup. */
  readonly sessionId: string | null;
  /** Most recent turn started in this process. */
  readonly runId: string | null;
  /** Caller-safe description of the latest failure; never contains provider responses. */
  readonly error: string | null;
}

/** Status of an agent whose runtime has not been loaded in this process. */
export const unloadedRuntimeStatus: RuntimeStatus = Object.freeze({
  status: "idle",
  sessionId: null,
  runId: null,
  error: null,
});
