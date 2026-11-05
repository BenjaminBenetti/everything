import type {
  CreateSubagentInput,
  Subagent,
} from "@everything/agent-contracts/subagent";
import type { MessagePage } from "@everything/conversation-contracts";

/** Both the authenticated owner and saved teammate constrain every background operation. */
export interface SubagentScope {
  readonly ownerId: string;
  readonly agentId: string;
}

/** How a temporary event session ended once its subtree is removed. */
export type WakeupOutcome = "completed" | "failed" | "cancelled";

/**
 * Follows one temporary event session for an internal caller. `accepted` runs synchronously when the
 * session receives its task, before any of its work can finish; `finished` runs once, after the
 * session and its descendants have stopped. A completed outcome means the last turn ended normally,
 * whatever it said; failed means that turn errored; cancelled means it was stopped first.
 */
export interface WakeupObserver {
  accepted(id: string): void;
  finished(outcome: WakeupOutcome): void;
}

/** Internal wakeup settings; the public endpoint supplies neither. */
export interface WakeupOptions {
  /** Who the task says it came from; defaults to an API event. */
  readonly source?: string;
  readonly observer?: WakeupObserver;
}

/** Owner-scoped background work exposed to API consumers. */
export interface SubagentOperations {
  /** Open and start a child of the main teammate without waiting for its result. */
  create(scope: SubagentScope, input: CreateSubagentInput): Promise<Subagent>;
  /**
   * Run an event prompt in a temporary child, deleting its subtree when it stops. An aborted `signal`
   * withdraws the event before it is accepted, including while it waits for the teammate's lock.
   */
  wakeup(
    scope: SubagentScope,
    input: CreateSubagentInput,
    signal?: AbortSignal,
    options?: WakeupOptions,
  ): Promise<Subagent>;
  /** List all background sessions without starting model work. */
  list(scope: SubagentScope): Promise<Subagent[]>;
  /** Stop a background session and its descendants and delete their transcripts. */
  delete(scope: SubagentScope, id: string): Promise<void>;
  /** Queue a message without interrupting the recipient's current turn. */
  send(scope: SubagentScope, id: string, text: string): Promise<Subagent>;
  /** Read a chronological page of conversation text, excluding provider and tool internals. */
  messages(
    scope: SubagentScope,
    id: string,
    before?: string,
  ): Promise<MessagePage>;
}
