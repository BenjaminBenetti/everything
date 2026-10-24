import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import type { FleetMcpServer } from "../../fleet/interface/fleet-mcp-server.js";
import type { AgentWorkspaces } from "../../workspace/interface/agent-workspaces.js";
import { ProviderUnavailableError } from "../error/runtime-errors.js";
import type {
  AgentSession,
  AgentSessionFactory,
  MessageDelivery,
} from "../interface/agent-session.js";
import { mainAgentPrompt } from "../prompt/main-agent-prompt.js";
import { appTools } from "../tool/app-tools.js";
import { sendMessageTool } from "../tool/send-message-tool.js";
import { PiAgentSession } from "./pi-agent-session.js";
import type {
  InferenceRuntime,
  InferenceRuntimeFactory,
} from "../interface/inference-runtime.js";
import { compactionPolicy } from "../model/compaction-policy.js";
import type { WorkspaceTools } from "../../workspace/interface/workspace-tools.js";
import { workspaceTools } from "../tool/workspace-tools.js";
import {
  fleetToolPattern,
  fleetTools,
  toolSearchToolName,
} from "../tool/fleet-tools.js";
import { forkTools } from "../tool/fork-tools.js";
import type { SessionForkOperations } from "../interface/session-forks.js";
import { ForkingAgentSession } from "../service/forking-agent-session.js";
import { PiForkHistory } from "./pi-fork-history.js";
import type { WorkspaceActivityRecorder } from "../../workspace/interface/workspace-activity.js";
import { fleetWorkspaceActivity } from "../tool/fleet-workspace-activity.js";
import type { ApiDocumentationReader } from "../../api-documentation/interface/api-documentation.js";
import { apiDocumentationTool } from "../../api-documentation/tool/api-documentation-tool.js";
import type { ConversationSearchReader } from "../../conversation/interface/conversation-search.js";
import { conversationSearchTool } from "../../conversation/tool/conversation-search-tool.js";
import { FleetMcpClient } from "../../fleet/adapter/fleet-mcp-client.js";
import { fleetCreationDefaults } from "../tool/fleet-creation-defaults.js";
import type { MonitorOperations } from "../../monitor/interface/monitor-operations.js";
import { monitorTools } from "../tool/monitor-tools.js";

/** Pi's per-agent configuration and session paths inside the agent's workspace. */
interface AgentDirectories {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
}

/** Adapts Pi's native session persistence and explicit messaging to the application interface. */
export class PiSessionFactory implements AgentSessionFactory {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive inference, workspace tools, Fleet, API documentation, conversation search, and optional interaction recording and monitors. */
  constructor(
    private readonly inference: InferenceRuntimeFactory,
    private readonly workspaces: Pick<AgentWorkspaces, "directory" | "shared">,
    private readonly artifacts: ArtifactWorkbench,
    private readonly workspace: WorkspaceTools,
    private readonly fleet: FleetMcpServer,
    private readonly apiDocumentation: ApiDocumentationReader,
    private readonly conversationSearch: ConversationSearchReader,
    private readonly workspaceActivity?: WorkspaceActivityRecorder,
    private readonly monitors?: MonitorOperations,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Reopen the main conversation and its private forks with one shared inference selection. */
  async create(
    agent: AgentDefinition,
    sendMessage: MessageDelivery,
  ): Promise<AgentSession> {
    const directories = this.directoriesFor(agent);
    if (!agent.inference) throw new ProviderUnavailableError();
    const inference = await this.inference.create(
      agent.ownerId,
      agent.inference,
    );
    await mkdir(directories.sessionDir, { recursive: true, mode: 0o700 });
    const main = SessionManager.continueRecent(
      directories.cwd,
      directories.sessionDir,
    );
    const histories = new PiForkHistory(
      directories.cwd,
      directories.agentDir,
      main,
    );
    let family: ForkingAgentSession;
    /** Bind tools lazily; the family is assembled before any model turn can call them. */
    function operations(sender: string): SessionForkOperations {
      return {
        fork: (task, context) => family.operations(sender).fork(task, context),
        send: (recipient, text) =>
          family.operations(sender).send(recipient, text),
        list: () => family.operations(sender).list(),
        stop: (id) => family.operations(sender).stop(id),
      };
    }
    /** Open every fork through the same configuration and owner-scoped tool bindings. */
    const open = (manager: SessionManager, parentId?: string) => {
      const sender = parentId === undefined ? "main" : manager.getSessionId();
      const messaging = operations(sender);
      return this.openSession(
        agent,
        directories,
        inference,
        manager,
        messaging,
        parentId === undefined
          ? sendMessage
          : async (text) => messaging.send("parent", text),
        parentId,
      );
    };
    const root = await open(main);
    family = new ForkingAgentSession(
      root,
      {
        /** Start fresh unless requested otherwise, removing setup state if opening fails. */
        create: async (parentId, context, temporary) => {
          const manager = histories.fork(parentId, context, temporary);
          try {
            return await open(manager, parentId);
          } catch (error) {
            await histories.remove([manager.getSessionId()]);
            throw error;
          }
        },
      },
      undefined,
      histories,
    );
    try {
      for (const { manager, parentId } of await histories.restore())
        family.restore(await open(manager, parentId), parentId);
      return family;
    } catch (error) {
      await family.dispose();
      throw error;
    }
  }

  /** Construct one session with identical settings, changing only private routing and session identity. */
  private async openSession(
    agent: AgentDefinition,
    directories: AgentDirectories,
    { models, model }: InferenceRuntime,
    sessionManager: SessionManager,
    messaging: SessionForkOperations,
    sendMessage: MessageDelivery,
    parentId?: string,
  ): Promise<PiAgentSession> {
    const settingsManager = SettingsManager.create(
      directories.cwd,
      directories.agentDir,
    );
    const resourceLoader = await this.isolatedResources(
      agent,
      directories,
      settingsManager,
      parentId === undefined
        ? undefined
        : { id: sessionManager.getSessionId(), parentId },
    );
    // Resource loading reloads settings, so enforce harness policy after it has completed.
    settingsManager.applyOverrides({
      retry: { enabled: false },
      compaction: compactionPolicy(model.contextWindow),
    });
    const tools = [
      sendMessageTool(sendMessage, parentId !== undefined),
      apiDocumentationTool(this.apiDocumentation, agent.id),
      conversationSearchTool(this.conversationSearch, {
        ownerId: agent.ownerId,
        agentId: agent.id,
      }),
      ...forkTools(messaging),
      ...workspaceTools(this.workspace, agent.id),
      // Completion events return to this teammate whichever session in its family started them.
      ...(this.monitors
        ? monitorTools(
            this.monitors,
            { ownerId: agent.ownerId, agentId: agent.id },
            parentId === undefined ? "main" : sessionManager.getSessionId(),
          )
        : []),
      ...appTools(this.artifacts, {
        ownerId: agent.ownerId,
        author: { id: agent.id, name: agent.name },
        workspace: directories.cwd,
        shared: this.workspaces.shared,
        privateDirectory: directories.agentDir,
      }),
    ];
    const { session } = await createAgentSession({
      cwd: directories.cwd,
      agentDir: directories.agentDir,
      modelRuntime: models,
      model,
      resourceLoader,
      settingsManager,
      thinkingLevel: agent.inference!.effort,
      tools: [
        ...tools.map((tool) => tool.name),
        toolSearchToolName,
        fleetToolPattern,
      ],
      customTools: tools,
      sessionManager,
    });
    // Starting the extensions connects Fleet's MCP server.
    await session.bindExtensions({});
    return new PiAgentSession(session, Date.now, {
      ownerId: agent.ownerId,
      agentId: agent.id,
      sessionKind: parentId === undefined ? "main" : "fork",
      ...(parentId !== undefined ? { parentSessionId: parentId } : {}),
      provider: agent.inference!.provider,
      model: agent.inference!.model,
    });
  }

  // ===========================================
  // Session resources
  // ===========================================

  /** Run Pi in the agent's working directory, keeping its configuration and sessions inside it. */
  private directoriesFor(agent: AgentDefinition): AgentDirectories {
    const cwd = this.workspaces.directory(agent.id);
    const agentDir = path.join(cwd, ".pi");
    return { cwd, agentDir, sessionDir: path.join(agentDir, "sessions") };
  }

  /**
   * Load only the agent's prompt and Fleet's MCP server: no discovered extensions, MCP configuration,
   * skills, templates, themes, or context files. Pi's working directory is the teammate's workspace,
   * at the same path in its pod, so the prompt's `cwd` section names it as the teammate's tools do.
   */
  private async isolatedResources(
    agent: AgentDefinition,
    { cwd, agentDir }: AgentDirectories,
    settingsManager: SettingsManager,
    fork?: { id: string; parentId: string },
  ): Promise<DefaultResourceLoader> {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [
        {
          name: "mcp",
          // Teammates connect only the servers the harness registers, never an mcp.json.
          factory: createMcpExtension({
            loadConfig: () => ({ servers: [], errors: [] }),
          }),
          hidden: true,
        },
        {
          name: "tool-search",
          factory: createToolSearchExtension(),
          hidden: true,
        },
        { name: "fleet-tools", factory: fleetTools(this.fleet), hidden: true },
        {
          name: "fleet-creation-defaults",
          factory: fleetCreationDefaults(new FleetMcpClient(this.fleet)),
          hidden: true,
        },
        ...(this.workspaceActivity
          ? [
              {
                name: "workspace-activity",
                factory: fleetWorkspaceActivity(this.workspaceActivity, {
                  ownerId: agent.ownerId,
                  agentId: agent.id,
                }),
                hidden: true,
              },
            ]
          : []),
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: mainAgentPrompt(agent, fork),
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    return resourceLoader;
  }
}
