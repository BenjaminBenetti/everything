import type {
  CreateSubagentInput,
  Subagent,
} from "@everything/agent-contracts/subagent";
import type { MessagePage } from "@everything/conversation-contracts";
import type { SubagentScope } from "./subagent-operations.js";

/** Saved background sessions can be inspected and removed without an active model provider. */
export interface SubagentArchive {
  /** List saved sessions and their available lifecycle state. */
  list(): Subagent[];
  /** Read text history for a known session. */
  messages(id: string, before?: string): MessagePage;
  /** Delete the named session and its descendants. */
  delete(id: string): Promise<void>;
}

/** A live family adds execution and private messaging to its saved history. */
export interface SubagentSession extends SubagentArchive {
  /** Start a child of the main teammate with shared settings and workspace. */
  create(input: CreateSubagentInput): Promise<Subagent>;
  /** Run temporary event work and remove it after completion or cancellation. */
  wakeup(input: CreateSubagentInput): Promise<Subagent>;
  /** Wake an idle session or queue behind its current work. */
  send(id: string, text: string): Subagent;
}

/** Serialize API operations with main-conversation interruption, deletion, and shutdown. */
export interface SubagentSessionAccess {
  /** Check ownership under the teammate lock; open a runtime only when load is true. */
  withSubagents<T>(
    scope: SubagentScope,
    load: boolean,
    operation: (session: SubagentSession | undefined) => Promise<T>,
  ): Promise<T>;
}

/** Open native history only after ownership has been checked by the session boundary. */
export interface SubagentArchives {
  /** Read saved state without creating a model session or starting inference. */
  open(scope: SubagentScope): Promise<SubagentArchive>;
}
