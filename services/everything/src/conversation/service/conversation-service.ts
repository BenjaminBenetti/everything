import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type { AgentRemoval } from "../../agent/interface/agent-removal.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { AgentSessionFactory } from "../../runtime/interface/agent-session.js";
import {
  unloadedRuntimeStatus,
  type RuntimeStatus,
} from "../../runtime/model/runtime-status.js";
import { AgentRuntime } from "../../runtime/service/agent-runtime.js";
import type { AgentWorkspaces } from "../../workspace/interface/agent-workspaces.js";
import { ServiceShuttingDownError } from "../error/conversation-errors.js";
import type { ConversationOperations } from "../interface/conversation-operations.js";
import type { ConversationMessageStore } from "../interface/message-repository.js";
import type { ConversationMessage, MessageReceipt } from "../model/message.js";
import { AgentLock } from "./agent-lock.js";

/** Coordinates durable chat and interruptible execution through runtime and storage interfaces. */
export class ConversationService
  implements ConversationOperations, AgentRemoval
{
  // ===========================================
  // State
  // ===========================================

  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly locks = new AgentLock();
  private closing = false;

  // ===========================================
  // Construction
  // ===========================================

  /** Inject agent ownership, visible-message storage, the runtime factory, and agent working directories. */
  constructor(
    private readonly agents: Pick<AgentCatalog, "get" | "delete">,
    private readonly messages: ConversationMessageStore,
    private readonly sessions: AgentSessionFactory,
    private readonly workspaces: Pick<AgentWorkspaces, "remove">,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Read visible messages only after verifying ownership. */
  async list(ownerId: string, agentId: string): Promise<ConversationMessage[]> {
    await this.agents.get(ownerId, agentId);
    return this.messages.list({ ownerId, agentId });
  }

  /** Interrupt previous work, persist the new input, and start an asynchronous run. */
  async send(
    ownerId: string,
    agentId: string,
    text: string,
  ): Promise<MessageReceipt> {
    return this.locks.run(agentId, async () => {
      if (this.closing) throw new ServiceShuttingDownError();
      const agent = await this.agents.get(ownerId, agentId);
      const runtime = await this.loadRuntime(agent);
      await runtime.stop();
      const message = await this.messages.append(
        { ownerId, agentId },
        "user",
        text,
      );
      return { messageId: message.id, runId: runtime.start(text) };
    });
  }

  /** Return execution status without exposing private Pi messages or storage paths. */
  async status(ownerId: string, agentId: string): Promise<RuntimeStatus> {
    await this.agents.get(ownerId, agentId);
    return this.runtimes.get(agentId)?.status ?? unloadedRuntimeStatus;
  }

  /** Stop active work while retaining the saved conversation. */
  async interrupt(ownerId: string, agentId: string): Promise<void> {
    await this.locks.run(agentId, async () => {
      await this.agents.get(ownerId, agentId);
      await this.runtimes.get(agentId)?.stop();
    });
  }

  /** Stop the runtime, delete the agent's files, then its definition and visible messages; a failure can be retried. */
  async delete(ownerId: string, agentId: string): Promise<void> {
    await this.locks.run(agentId, async () => {
      await this.agents.get(ownerId, agentId);
      await this.unloadRuntime(agentId);
      await this.workspaces.remove(agentId);
      await this.agents.delete(ownerId, agentId);
    });
  }

  /** Reject new work and flush active runtime operations before the process exits. */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(
      [...this.runtimes.keys()].map((agentId) =>
        this.locks.run(agentId, () => this.unloadRuntime(agentId)),
      ),
    );
  }

  // ===========================================
  // Runtime lifecycle
  // ===========================================

  /** Reuse the agent's loaded runtime or reopen its durable session; the caller holds the agent's lock. */
  private async loadRuntime(agent: AgentDefinition): Promise<AgentRuntime> {
    const loaded = this.runtimes.get(agent.id);
    if (loaded) return loaded;
    const session = await this.sessions.create(agent, (text) =>
      this.appendReply(agent, text),
    );
    const runtime = new AgentRuntime(session);
    this.runtimes.set(agent.id, runtime);
    return runtime;
  }

  /** Stop and release a loaded runtime; one already unloaded, for example by deletion, is ignored. */
  private async unloadRuntime(agentId: string): Promise<void> {
    const runtime = this.runtimes.get(agentId);
    if (!runtime) return;
    await runtime.close();
    this.runtimes.delete(agentId);
  }

  /** Persist a message the agent deliberately sent to its owner. */
  private async appendReply(
    agent: AgentDefinition,
    text: string,
  ): Promise<void> {
    await this.messages.append(
      { ownerId: agent.ownerId, agentId: agent.id },
      "assistant",
      text,
    );
  }
}
