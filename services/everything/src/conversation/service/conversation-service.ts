import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type { AgentRemoval } from "../../agent/interface/agent-removal.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { AgentSessionFactory } from "../../runtime/interface/agent-session.js";
import {
  unloadedRuntimeStatus,
  type RuntimeStatus,
} from "../../runtime/model/runtime-status.js";
import { AgentRuntime } from "../../runtime/service/agent-runtime.js";
import { ReplyingAgentSession } from "../../runtime/service/replying-agent-session.js";
import type { AgentWorkspaces } from "../../workspace/interface/agent-workspaces.js";
import { ServiceShuttingDownError } from "../error/conversation-errors.js";
import type { ConversationOperations } from "../interface/conversation-operations.js";
import type { ConversationMessageStore } from "../interface/message-repository.js";
import type { MessagePage, MessageReceipt } from "../model/message.js";
import { AgentLock } from "./agent-lock.js";

/** Coordinates durable chat and interruptible execution through runtime and storage interfaces. */
export class ConversationService
  implements ConversationOperations, AgentRemoval
{
  // ===========================================
  // State
  // ===========================================

  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly runtimeDefinitions = new Map<string, string>();
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

  /** Read a page of visible history only after verifying ownership. */
  async list(
    ownerId: string,
    agentId: string,
    before?: string,
  ): Promise<MessagePage> {
    await this.agents.get(ownerId, agentId);
    return this.messages.page({ ownerId, agentId }, before);
  }

  /** Interrupt the main turn, retain background forks, and persist and start the new user input. */
  async send(
    ownerId: string,
    agentId: string,
    text: string,
  ): Promise<MessageReceipt> {
    return this.locks.run(agentId, async () => {
      if (this.closing) throw new ServiceShuttingDownError();
      const agent = await this.agents.get(ownerId, agentId);
      const runtime = await this.loadRuntime(agent);
      await runtime.stop("turn");
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

  /** Stop work, remove desired state, then clean up its pod and files; reconciliation retries interrupted cleanup. */
  async delete(ownerId: string, agentId: string): Promise<void> {
    await this.locks.run(agentId, async () => {
      await this.agents.get(ownerId, agentId);
      await this.unloadRuntime(agentId);
      await this.agents.delete(ownerId, agentId);
      await this.workspaces.remove(agentId);
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

  /** Apply profile changes on the next turn while reopening the same durable session and history. */
  private async loadRuntime(agent: AgentDefinition): Promise<AgentRuntime> {
    const loaded = this.runtimes.get(agent.id);
    const definition = JSON.stringify([
      agent.name,
      agent.systemPrompt,
      agent.inference,
    ]);
    if (loaded && this.runtimeDefinitions.get(agent.id) === definition)
      return loaded;
    if (loaded) await this.unloadRuntime(agent.id);
    let delivered = 0;
    const session = await this.sessions.create(agent, async (text) => {
      await this.appendReply(agent, text);
      delivered++;
    });
    const runtime = new AgentRuntime(
      new ReplyingAgentSession(session, () => delivered),
    );
    this.runtimes.set(agent.id, runtime);
    this.runtimeDefinitions.set(agent.id, definition);
    return runtime;
  }

  /** Stop and release a loaded runtime; one already unloaded, for example by deletion, is ignored. */
  private async unloadRuntime(agentId: string): Promise<void> {
    const runtime = this.runtimes.get(agentId);
    if (!runtime) return;
    await runtime.close();
    this.runtimes.delete(agentId);
    this.runtimeDefinitions.delete(agentId);
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
