import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { workspaceMountPath } from "@everything/workspace-contracts/mount";
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
import type {
  InferenceRuntime,
  InferenceRuntimeFactory,
} from "../interface/inference-runtime.js";
import { compactionPolicy } from "../model/compaction-policy.js";
import type { WorkspaceTools } from "../../workspace/interface/workspace-tools.js";
import { workspaceTools } from "../tool/workspace-tools.js";
import { forkTools } from "../tool/fork-tools.js";
import type { SessionForkOperations } from "../interface/session-forks.js";
import { ForkingAgentSession } from "../service/forking-agent-session.js";
import { PiForkHistory } from "./pi-fork-history.js";

/** Pi's per-agent configuration and session paths inside the agent's workspace. */
interface AgentDirectories {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
}

/**
 * Name the working directory in the prompt's `cwd` section as the teammate's pod mounts it. Pi keeps
 * its real working directory, which locates the teammate's saved sessions in this process.
 */
function podWorkingDirectory(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.cwd = workspaceMountPath;
  });
}

/** Adapts Pi's native session persistence and explicit messaging to the application interface. */
export class PiSessionFactory implements AgentSessionFactory {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive owner-scoped inference, working directories, shared artifacts, and isolated workspace tools. */
  constructor(
    private readonly inference: InferenceRuntimeFactory,
    private readonly workspaces: Pick<AgentWorkspaces, "directory">,
    private readonly artifacts: ArtifactWorkbench,
    private readonly workspace: WorkspaceTools,
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
    family = new ForkingAgentSession(root, {
      /** Start fresh unless the caller explicitly requests a snapshot of its context. */
      create: async (parentId, context) =>
        open(histories.fork(parentId, context), parentId),
    });
    try {
      for (const { manager, parentId } of await histories.restore())
        family.restore(await open(manager, parentId), parentId);
      return family;
    } catch (error) {
      family.dispose();
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
      ...forkTools(messaging),
      ...workspaceTools(this.workspace, agent.id),
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
      thinkingLevel: agent.inference!.effort,
      tools: tools.map((tool) => tool.name),
      customTools: tools,
      sessionManager,
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

  /**
   * Load only the agent's prompt and the harness's own prompt adjustment: no discovered extensions,
   * skills, templates, themes, or context files.
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
          name: "pod-working-directory",
          factory: podWorkingDirectory,
          hidden: true,
        },
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
