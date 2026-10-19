import type {
  CreateSubagentInput,
  Subagent,
} from "@everything/agent-contracts/subagent";
import type { MessagePage } from "@everything/conversation-contracts";
import { SubagentsUnavailableError } from "../error/subagent-errors.js";
import type {
  SubagentOperations,
  SubagentScope,
} from "../interface/subagent-operations.js";
import type {
  SubagentArchives,
  SubagentSession,
  SubagentSessionAccess,
} from "../interface/subagent-sessions.js";

/** Coordinate background API operations through the teammate's existing runtime and native archive. */
export class SubagentService implements SubagentOperations {
  // ===========================================
  // Construction
  // ===========================================

  /** Reuse the main conversation's ownership lock and provider-independent history reader. */
  constructor(
    private readonly sessions: SubagentSessionAccess,
    private readonly archives: SubagentArchives,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Start background work without sending a user message to the main conversation. */
  create(scope: SubagentScope, input: CreateSubagentInput): Promise<Subagent> {
    return this.sessions.withSubagents(scope, true, async (session) =>
      this.requireSession(session).create(input),
    );
  }

  /** Accept an event for temporary background processing through the same ownership boundary. */
  wakeup(
    scope: SubagentScope,
    input: CreateSubagentInput,
    signal?: AbortSignal,
  ): Promise<Subagent> {
    return this.sessions.withSubagents(scope, true, async (session) => {
      // Checked under the lock, so a Stop that ran first withdraws the event.
      signal?.throwIfAborted();
      return this.requireSession(session).wakeup(input);
    });
  }

  /** Inspect live state or saved histories without starting any model work. */
  list(scope: SubagentScope): Promise<Subagent[]> {
    return this.sessions.withSubagents(scope, false, async (session) =>
      (session ?? (await this.archives.open(scope))).list(),
    );
  }

  /** Stop and permanently remove the selected subtree, including after a process restart. */
  delete(scope: SubagentScope, id: string): Promise<void> {
    return this.sessions.withSubagents(scope, false, async (session) =>
      (session ?? (await this.archives.open(scope))).delete(id),
    );
  }

  /** Enqueue private input while preserving any current main or background turn. */
  send(scope: SubagentScope, id: string, text: string): Promise<Subagent> {
    return this.sessions.withSubagents(scope, true, async (session) =>
      this.requireSession(session).send(id, text),
    );
  }

  /** Read safe transcript text from the loaded family or its durable archive. */
  messages(
    scope: SubagentScope,
    id: string,
    before?: string,
  ): Promise<MessagePage> {
    return this.sessions.withSubagents(scope, false, async (session) =>
      (session ?? (await this.archives.open(scope))).messages(id, before),
    );
  }

  // ===========================================
  // Runtime validation
  // ===========================================

  /** Reject unsupported runtime implementations before accepting background work. */
  private requireSession(
    session: SubagentSession | undefined,
  ): SubagentSession {
    if (!session) throw new SubagentsUnavailableError();
    return session;
  }
}
