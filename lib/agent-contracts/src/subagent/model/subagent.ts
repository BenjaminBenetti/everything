/** One background session within a saved teammate's family. */
export interface Subagent {
  readonly id: string;
  readonly parentId: string;
  readonly status: "running" | "queued" | "idle" | "stopped" | "error";
}

/** Start background work with the teammate's settings and optionally its current context. */
export interface CreateSubagentInput {
  readonly task: string;
  readonly context?: boolean;
}

/** Background sessions belonging to one teammate, including nested descendants. */
export interface SubagentList {
  readonly subagents: Subagent[];
}

/** Native transcript entry IDs are opaque cursors, distinct from session UUIDs. */
export const subagentCursorMaxLength = 128;
