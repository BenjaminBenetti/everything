import type { AgentSession } from "./agent-session.js";

/** Private address and lifecycle of a teammate's background session. */
export interface SessionFork {
  readonly id: string;
  readonly parentId: string;
  readonly status: "running" | "queued" | "idle" | "stopped" | "error";
}

/** Tools receive only the operations bound to their own conversation family. */
export interface SessionForkOperations {
  /** Begin a background task with fresh context unless copying the caller's history is requested. */
  fork(task: string, context?: boolean): Promise<SessionFork>;
  /** Queue a private message, waking an idle recipient without waiting for its answer. */
  send(recipient: string, text: string): void;
  /** List private forks belonging to this teammate. */
  list(): SessionFork[];
  /** Stop a descendant and its children, retaining their histories. */
  stop(id: string): Promise<void>;
}

/** Session state needed to return an undelivered background result to its parent. */
export interface ForkableSession extends AgentSession {
  readonly lastResponse: string | undefined;
}

/** Opens provider-specific sessions without exposing their history to the coordinator. */
export interface SessionForkFactory {
  /** Open a separate session with the same configuration, optionally copying the parent's history. */
  create(parentId: string, context: boolean): Promise<ForkableSession>;
}
