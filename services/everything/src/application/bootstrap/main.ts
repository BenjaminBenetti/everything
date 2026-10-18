import { KeycloakPasswordAuthentication } from "@everything/security/password-grant";
import { SessionCipher } from "@everything/security/session-cipher";
import { SessionService } from "../../session/service/session-service.js";
import { PostgresSessionRepository } from "../../session/repository/postgres-session-repository.js";
import type { FastifyInstance } from "fastify";
import { createKeycloakTokenVerifier } from "@everything/security/keycloak";
import { appIdentity } from "../../identity/service/app-identity.js";
import { KeycloakClientCredentials } from "@everything/security/client-credentials";
import { HttpArtifactGateway } from "../../artifact/adapter/http-artifact-gateway.js";
import { ArtifactLibraryService } from "../../artifact/service/artifact-library-service.js";
import { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import { PostgresAgentRepository } from "../../agent/repository/postgres-agent-repository.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import { AgentService } from "../../agent/service/agent-service.js";
import {
  AgentActivityService,
  recentAgentListing,
} from "../../agent/service/agent-activity-service.js";
import { PostgresAgentActivityRepository } from "../../agent/repository/postgres-agent-activity-repository.js";
import { AgentEditingService } from "../../agent/service/agent-editing-service.js";
import { PostgresMessageRepository } from "../../conversation/repository/postgres-message-repository.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import { ConversationSearchService } from "../../conversation/service/conversation-search-service.js";
import { SubagentService } from "../../subagent/service/subagent-service.js";
import { PiSubagentArchives } from "../../subagent/adapter/pi-subagent-archives.js";
import { ApiDocumentationService } from "../../api-documentation/service/api-documentation-service.js";
import { ModelUpdateSummarizer } from "../../update/adapter/model-update-summarizer.js";
import { PostgresUpdateRepository } from "../../update/repository/postgres-update-repository.js";
import { UpdateSummaryScheduler } from "../../update/service/update-summary-scheduler.js";
import { UpdateService } from "../../update/service/update-service.js";
import { HttpUpgrader } from "../../upgrade/adapter/http-upgrader.js";
import { ProjectedTokenSource } from "../../upgrade/adapter/projected-token-source.js";
import { UnavailableUpgrades } from "../../upgrade/adapter/unavailable-upgrades.js";
import { GeneralSettingsService } from "../../settings/service/general-settings-service.js";
import { PostgresGeneralSettingsRepository } from "../../settings/repository/postgres-general-settings-repository.js";
import { TeammateOrderService } from "../../settings/service/teammate-order-service.js";
import { createApplicationDatabase } from "../../persistence/factory/application-database.js";
import { PiSessionFactory } from "../../runtime/adapter/pi-session-factory.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { loadApplicationConfig } from "../config/application-config.js";
import { createHttpApplication } from "../factory/http-application.js";
import { createOidcIdentityVerifier } from "@everything/security/oidc";
import { KeyService } from "../../key/service/key-service.js";
import { PostgresKeyRepository } from "../../key/repository/postgres-key-repository.js";
import { PostgresSshKeyRepository } from "../../key/repository/postgres-ssh-key-repository.js";
import { SshEnabledKeys } from "../../key/service/ssh-enabled-keys.js";
import { createSshRuntime } from "../../ssh/factory/ssh-runtime.js";
import {
  fleetGitAgentSocket,
  sshAgentSocket,
} from "../../ssh/model/ssh-sockets.js";
import { fleetHome } from "../../fleet/model/fleet-home.js";
import { sshAgentHostSocket } from "@everything/workspace-contracts/mount";
import { isSshKeyMaterial } from "@everything/key-contracts/ssh";
import { PostgresProviderRepository } from "../../provider/repository/postgres-provider-repository.js";
import { ProviderConnectionService } from "../../provider/service/provider-connections.js";
import { OpenAiChatGptAuthorization } from "../../provider/adapter/chatgpt-authorization.js";
import { ChatGptConnectionVerifier } from "../../provider/adapter/chatgpt-connection-verifier.js";
import { AnthropicConnectionVerifier } from "../../provider/adapter/anthropic-connection-verifier.js";
import { CompatibleConnectionVerifier } from "../../provider/adapter/compatible-connection-verifier.js";
import { HttpModelDiscovery } from "../../provider/adapter/http-model-discovery.js";
import { ProviderModelService } from "../../provider/service/provider-models.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { PiInferenceRuntimeFactory } from "../../runtime/adapter/pi-inference-runtime.js";
import { PostgresProviderCheckRepository } from "../../provider/repository/postgres-provider-check-repository.js";
import { ProviderCheckScheduler } from "../../provider/service/provider-check-scheduler.js";
import {
  KubernetesWorkspacePods,
  createWorkspacePodClients,
} from "../../workspace/adapter/kubernetes-workspace-pods.js";
import { HttpWorkspaceTools } from "../../workspace/adapter/http-workspace-tools.js";
import { HttpWorkspaceMonitors } from "../../workspace/adapter/http-workspace-monitors.js";
import { MonitorService } from "../../monitor/service/monitor-service.js";
import { PostgresWorkspaceTargetRepository } from "../../workspace/repository/postgres-workspace-target-repository.js";
import { WorkspaceReconciler } from "../../workspace/service/workspace-reconciler.js";
import { createFleetRuntime } from "../../fleet/factory/fleet-runtime.js";
import { PostgresWorkspaceInteractionRepository } from "../../workspace/repository/postgres-workspace-interaction-repository.js";
import {
  WorkspaceActivity,
  recentWorkspaceListing,
} from "../../workspace/service/workspace-activity.js";

/** Assemble concrete adapters once at the process boundary and own their lifecycle. */
async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadApplicationConfig(process.env);
  const verifier = createKeycloakTokenVerifier({
    jwksUrl: config.jwksUrl,
    issuer: config.issuer,
    audience: config.audience,
    resolveIdentity: appIdentity,
  });
  const database = createApplicationDatabase(config);
  await database.initialize();
  await database.runMigrations();
  const sshKeys = new PostgresSshKeyRepository(database);
  const ssh = createSshRuntime(
    {
      /** Read the installation's SSH pool without bringing user metadata into runtime state. */
      read: async () =>
        (await sshKeys.list({ usage: "installation-ssh" })).map(
          ({ id, encryptedMaterial }) => ({ id, encryptedMaterial }),
        ),
    },
    new SessionCipher(config.sessionEncryptionKey),
    {
      agent: sshAgentSocket,
      consumers: sshAgentHostSocket,
      fleetGit: fleetGitAgentSocket,
      fleetClients: fleetHome(config.fleet.home).sshAgentRelay,
    },
    () =>
      console.warn("SSH keys could not synchronize; Everything will retry."),
  );
  await ssh.start();
  const providers = new ProviderConnectionService(
    new PostgresProviderRepository(database),
    new SessionCipher(config.sessionEncryptionKey),
    {
      chatgpt: new ChatGptConnectionVerifier(),
      anthropic: new AnthropicConnectionVerifier(),
      "openai-compatible": new CompatibleConnectionVerifier(),
    },
    new OpenAiChatGptAuthorization(
      createOidcIdentityVerifier(
        "https://auth.openai.com",
        "https://auth.openai.com/.well-known/jwks.json",
      ),
      config.chatGptRedirectUri,
    ),
  );
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  const models = new ProviderModelService(
    providers,
    new HttpModelDiscovery(),
    capabilities,
  );
  const agentRepository = new PostgresAgentRepository(database);
  const agents = new AgentService(agentRepository, models);
  const workspaceFiles = new FileSystemWorkspaces(config.agentsDirectory);
  await workspaceFiles.createShared();
  const workspaces = new WorkspaceReconciler(
    new PostgresWorkspaceTargetRepository(database),
    new KubernetesWorkspacePods(createWorkspacePodClients(), {
      ...config.workspacePods,
      key: config.sessionEncryptionKey,
    }),
    workspaceFiles,
    (agentId) =>
      console.warn("Teammate workspace reconciliation failed; it will retry.", {
        agentId,
      }),
  );
  const artifactGateway = new HttpArtifactGateway(
    {
      url: config.artifactService.url,
      hostUrl: config.artifactService.hostUrl,
    },
    new KeycloakClientCredentials({
      protocolUrl: config.protocolUrl,
      publicOrigin: config.publicOrigin,
      clientId: config.artifactService.clientId,
      clientSecret: config.artifactService.clientSecret,
    }),
  );
  const {
    host: fleet,
    clients: fleetClientAddress,
    workers,
    workspaces: workspaceInstances,
  } = createFleetRuntime(
    config.fleet,
    config.agentsDirectory,
    (error) =>
      console.warn("Fleet failed; Everything will retry.", {
        reason: error instanceof Error ? error.message : "unknown",
      }),
    { ...process.env, SSH_AUTH_SOCK: sshAgentHostSocket },
  );
  await fleetClientAddress?.prepare();
  const inference = new PiInferenceRuntimeFactory(
    providers,
    models,
    capabilities,
  );
  const updates = new PostgresUpdateRepository(database);
  const generalSettingsRepository = new PostgresGeneralSettingsRepository(
    database,
  );
  const generalSettings = new GeneralSettingsService(generalSettingsRepository);
  const workspaceActivity = new WorkspaceActivity(
    agents,
    new PostgresWorkspaceInteractionRepository(
      database,
      recentWorkspaceListing,
    ),
    workspaceInstances,
  );
  const apiDocumentation = new ApiDocumentationService();
  const messages = new PostgresMessageRepository(database);
  let subagents!: SubagentService;
  // Completion events use the same owner-scoped wakeup service as the public endpoint, bound once composed.
  const monitors = new MonitorService(
    new HttpWorkspaceMonitors(
      config.workspacePods.namespace,
      config.sessionEncryptionKey,
    ),
    {
      wakeup: (scope, input, signal) => subagents.wakeup(scope, input, signal),
    },
    (failure) =>
      console.warn(
        "A monitor's completion event could not be delivered.",
        failure,
      ),
  );
  const conversations = new ConversationService(
    agents,
    messages,
    new PiSessionFactory(
      inference,
      workspaces,
      new ArtifactWorkbench(artifactGateway),
      new HttpWorkspaceTools(
        config.workspacePods.namespace,
        config.sessionEncryptionKey,
      ),
      fleet,
      apiDocumentation,
      new ConversationSearchService(messages),
      workspaceActivity,
      monitors,
    ),
    workspaces,
    monitors,
  );
  subagents = new SubagentService(
    conversations,
    new PiSubagentArchives(workspaces),
  );
  const app = await createHttpApplication({
    apiDocumentation,
    keys: new SshEnabledKeys(
      new KeyService(
        new PostgresKeyRepository(database),
        new SessionCipher(config.sessionEncryptionKey),
        new Map([["ssh", { accepts: isSshKeyMaterial }]]),
      ),
      ssh.keys,
    ),
    providers,
    models,
    chatGptRedirectUri: config.chatGptRedirectUri,
    agents,
    profiles: new AgentEditingService(agentRepository, models),
    agentActivity: new AgentActivityService(
      new PostgresAgentActivityRepository(database, recentAgentListing),
    ),
    removal: conversations,
    conversations,
    subagents,
    updates: new UpdateService(updates, generalSettings),
    upgrades: config.upgrader.url
      ? new HttpUpgrader(
          config.upgrader.url,
          new ProjectedTokenSource(config.upgrader.tokenFile),
        )
      : new UnavailableUpgrades(),
    generalSettings,
    teammateOrder: new TeammateOrderService(generalSettingsRepository),
    artifacts: new ArtifactLibraryService(artifactGateway),
    workers,
    workspaces: workspaceInstances,
    workspaceActivity,
    verifier,
    sessions: new SessionService(
      new PostgresSessionRepository(database),
      new KeycloakPasswordAuthentication(config, verifier),
      new SessionCipher(config.sessionEncryptionKey),
    ),
    publicOrigin: config.publicOrigin,
    /** Check the durable backing store before advertising readiness. */
    readiness: async () => {
      await database.getRepository(AgentEntity).exists();
      await ssh.check();
    },
  });
  const summaries = new UpdateSummaryScheduler(
    updates,
    new ModelUpdateSummarizer(inference),
    generalSettings,
    () =>
      app.log.warn(
        "An update summary could not complete; the update's source remains available.",
      ),
  );
  const providerChecks = new ProviderCheckScheduler(
    new PostgresProviderCheckRepository(database),
    providers,
    () =>
      app.log.warn(
        "Automatic provider checks could not complete; scheduling will retry.",
      ),
  );
  app.addHook("onClose", async () => {
    await summaries.close();
    await providerChecks.close();
    await monitors.close();
    await conversations.close();
    await workspaces.close();
    await fleetClientAddress?.close();
    await fleet.close();
    await ssh.close();
    await database.destroy();
  });
  closeOnTermination(app);
  await app.listen({ host: "0.0.0.0", port: config.port });
  summaries.start();
  providerChecks.start();
  workspaces.start();
  fleet.start();
  fleetClientAddress?.start();
}

/** Drain requests and Pi tool writes before Kubernetes terminates the pod. */
function closeOnTermination(app: FastifyInstance): void {
  /** Close the application, then exit with an outcome Kubernetes can report. */
  async function shutdown(): Promise<void> {
    try {
      await app.close();
      process.exit(0);
    } catch {
      console.error("Graceful shutdown failed.");
      process.exit(1);
    }
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/** Log the failure's type and location only; messages may contain configuration values. */
function reportStartupFailure(error: unknown): never {
  const failure = error as { name?: string; code?: string; stack?: string };
  console.error("Everything could not start", {
    name: failure.name,
    code: failure.code,
    stack: failure.stack?.split("\n").slice(1).join("\n"),
  });
  process.exit(1);
}

main().catch(reportStartupFailure);
