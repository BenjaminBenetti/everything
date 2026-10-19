import type { AgentDefinition } from "../../agent/model/agent.js";
import type { SubagentSession } from "../../subagent/interface/subagent-sessions.js";

/** Commits text the agent deliberately sends to the user's visible conversation. */
export type MessageDelivery = (text: string) => Promise<void>;

/** One agent's loaded model session, independent of the runtime implementation. */
export interface AgentSession {
  /** Optional background API for runtimes that own durable private session families. */
  readonly subagents?: SubagentSession | undefined;
  /** Durable session identifier, stable across process restarts. */
  readonly id: string;
  /** Whether the model is summarizing older context before continuing. */
  readonly compacting: boolean;
  /** Server timestamp for the current compaction; cleared when it ends or is cancelled. */
  readonly compactionStartedAt: string | null;
  /** The tool the latest prompt finished last, if it ran any. */
  readonly lastToolName: string | undefined;
  /** Whether the model is writing a message to the user, until that message is delivered. */
  readonly typing: boolean;
  /** Optional work owned by internal sessions, including a main turn awakened by a fork. */
  readonly background?:
    | {
        readonly running: boolean;
        /** Whether the main session itself is running, such as a turn a fork's result woke; forks never count. */
        readonly mainRunning: boolean;
        readonly failed: boolean;
        /** Displayed fork count, including a ten-second idle grace period and excluding the main session. */
        readonly activeCount: number;
      }
    | undefined;
  /** Run the model until it settles; ordinary model text is never a user message. */
  prompt(text: string): Promise<void>;
  /** Abort the main turn or, by default, all background work, waiting for tools to settle. */
  abort(scope?: "turn" | "all"): Promise<void>;
  /** Release runtime resources after work has stopped, closing connections such as MCP servers'. */
  dispose(): Promise<void>;
}

/** Opens durable agent sessions for the conversation service. */
export interface AgentSessionFactory {
  /** Open the agent's durable session and wire its explicit user messaging tool. */
  create(
    agent: AgentDefinition,
    sendMessage: MessageDelivery,
  ): Promise<AgentSession>;
}
