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
import { artifactTools } from "../tool/artifact-tools.js";
import { sendMessageTool } from "../tool/send-message-tool.js";
import { PiAgentSession } from "./pi-agent-session.js";
import type { InferenceRuntimeFactory } from "../interface/inference-runtime.js";
import { compactionPolicy } from "../model/compaction-policy.js";
import type { WorkspaceTools } from "../../workspace/interface/workspace-tools.js";
import { workspaceTools } from "../tool/workspace-tools.js";
import {
  fleetToolPattern,
  fleetTools,
  toolSearchToolName,
} from "../tool/fleet-tools.js";

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

  /** Receive owner-scoped inference, working directories, shared artifacts, isolated workspace tools, and Fleet. */
  constructor(
    private readonly inference: InferenceRuntimeFactory,
    private readonly workspaces: Pick<AgentWorkspaces, "directory" | "shared">,
    private readonly artifacts: ArtifactWorkbench,
    private readonly workspace: WorkspaceTools,
    private readonly fleet: FleetMcpServer,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Reopen this agent's native JSONL session on the connected provider, with an explicit tool allowlist. */
  async create(
    agent: AgentDefinition,
    sendMessage: MessageDelivery,
  ): Promise<AgentSession> {
    const directories = this.directoriesFor(agent);
    if (!agent.inference) throw new ProviderUnavailableError();
    const { models, model } = await this.inference.create(
      agent.ownerId,
      agent.inference,
    );
    await mkdir(directories.sessionDir, { recursive: true, mode: 0o700 });
    const settingsManager = SettingsManager.create(
      directories.cwd,
      directories.agentDir,
    );
    const resourceLoader = await this.isolatedResources(
      agent,
      directories,
      settingsManager,
    );
    // Resource loading reloads settings, so enforce harness policy after it has completed.
    settingsManager.applyOverrides({
      retry: { enabled: false },
      compaction: compactionPolicy(model.contextWindow),
    });
    const tools = [
      sendMessageTool(sendMessage),
      ...workspaceTools(this.workspace, agent.id),
      ...artifactTools(this.artifacts, {
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
      thinkingLevel: agent.inference.effort,
      tools: [
        ...tools.map((tool) => tool.name),
        toolSearchToolName,
        fleetToolPattern,
      ],
      customTools: tools,
      sessionManager: SessionManager.continueRecent(
        directories.cwd,
        directories.sessionDir,
      ),
    });
    // Starting the extensions connects Fleet's MCP server.
    await session.bindExtensions({});
    return new PiAgentSession(session);
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
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: mainAgentPrompt(agent),
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    return resourceLoader;
  }
}
