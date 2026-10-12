import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
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

  /** Receive owner-scoped inference, the teammates' working directories, and the shared artifacts. */
  constructor(
    private readonly inference: InferenceRuntimeFactory,
    private readonly workspaces: Pick<AgentWorkspaces, "directory">,
    private readonly artifacts: ArtifactWorkbench,
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
    settingsManager.applyOverrides({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const resourceLoader = await this.isolatedResources(
      agent,
      directories,
      settingsManager,
    );
    const tools = [
      sendMessageTool(sendMessage),
      ...artifactTools(this.artifacts, {
        ownerId: agent.ownerId,
        author: { id: agent.id, name: agent.name },
        workspace: directories.cwd,
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
      tools: tools.map((tool) => tool.name),
      customTools: tools,
      sessionManager: SessionManager.continueRecent(
        directories.cwd,
        directories.sessionDir,
      ),
    });
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

  /** Load only the agent's prompt: no extensions, skills, templates, themes, or context files. */
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
