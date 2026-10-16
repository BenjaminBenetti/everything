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

/** Owner-scoped background work exposed to API consumers. */
export interface SubagentOperations {
  /** Open and start a child of the main teammate without waiting for its result. */
  create(scope: SubagentScope, input: CreateSubagentInput): Promise<Subagent>;
  /** Run an event prompt in a temporary child, deleting its subtree when it stops. */
  wakeup(scope: SubagentScope, input: CreateSubagentInput): Promise<Subagent>;
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
