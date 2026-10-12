import type { AgentDefinition } from "../../agent/model/agent.js";

/** Commits text the agent deliberately sends to the user's visible conversation. */
export type MessageDelivery = (text: string) => Promise<void>;

/** One agent's loaded model session, independent of the runtime implementation. */
export interface AgentSession {
  /** Durable session identifier, stable across process restarts. */
  readonly id: string;
  /** Whether the model is summarizing older context before continuing. */
  readonly compacting: boolean;
  /** Run the model until it settles; ordinary model text is never a user message. */
  prompt(text: string): Promise<void>;
  /** Abort active generation and wait for its tool execution to settle. */
  abort(): Promise<void>;
  /** Release runtime resources after work has stopped. */
  dispose(): void;
}

/** Opens durable agent sessions for the conversation service. */
export interface AgentSessionFactory {
  /** Open the agent's durable session and wire its explicit user messaging tool. */
  create(
    agent: AgentDefinition,
    sendMessage: MessageDelivery,
  ): Promise<AgentSession>;
}
