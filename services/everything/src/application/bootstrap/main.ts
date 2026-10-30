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
import { PostgresAttachmentRepository } from "../../attachment/repository/postgres-attachment-repository.js";
import { WorkspaceAttachmentFiles } from "../../attachment/adapter/workspace-attachment-files.js";
import { AttachmentService } from "../../attachment/service/attachment-service.js";
import { AttachmentExpiry } from "../../attachment/service/attachment-expiry.js";
import { AttachmentExpiryScheduler } from "../../attachment/service/attachment-expiry-scheduler.js";
import { FileSystemWorkspaceImages } from "../../workspace/adapter/file-system-workspace-images.js";
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
import { PostgresGenericCredentialRepository } from "../../key/repository/postgres-generic-credential-repository.js";
import { CredentialGrants } from "../../credential/service/credential-grants.js";
import { CredentialRollouts } from "../../credential/service/credential-rollouts.js";
import { CredentialSyncScheduler } from "../../credential/service/credential-sync-scheduler.js";
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
import { createVoiceRuntime } from "../../voice/factory/voice-runtime.js";
import { createTelemetryReader } from "../../telemetry/factory/telemetry-reader.js";
import { activeTelemetry } from "../../telemetry/factory/telemetry-runtime.js";
import {
  recordWarning,
  reportWarning,
} from "../../telemetry/service/diagnostic-warnings.js";

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
      reportWarning("SSH keys could not synchronize; Everything will retry."),
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
      reportWarning(
        "Teammate workspace reconciliation failed; it will retry.",
        {
          agentId,
        },
      ),
  );
  const artifactGateway = new HttpArtifactGateway(
    {
      url: config.artifactService.url,
      hostUrl: config.artifactService.hostUrl,
      publicAppsHostUrl: config.artifactService.publicAppsHostUrl,
    },
    new KeycloakClientCredentials({
      protocolUrl: config.protocolUrl,
      publicOrigin: config.publicOrigin,
      clientId: config.artifactService.clientId,
      clientSecret: config.artifactService.clientSecret,
    }),
  );
  const genericCredentials = new PostgresGenericCredentialRepository(database);
  const credentialRollouts = new CredentialRollouts(
    genericCredentials,
    new SessionCipher(config.sessionEncryptionKey),
    artifactGateway,
    (task) =>
      console.warn(
        `A credential ${task} couldn't finish; Everything will retry.`,
      ),
  );
  const credentialGrants = new CredentialGrants(
    genericCredentials,
    new SessionCipher(config.sessionEncryptionKey),
    artifactGateway,
    credentialRollouts,
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
      reportWarning("Fleet failed; Everything will retry.", {
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
      reportWarning("A monitor's completion event could not be delivered.", {
        ...failure,
      }),
  );
  const conversations = new ConversationService(
    agents,
    messages,
    new PiSessionFactory(
      inference,
      workspaces,
      new ArtifactWorkbench(artifactGateway, credentialGrants),
      new HttpWorkspaceTools(
        config.workspacePods.namespace,
        config.sessionEncryptionKey,
      ),
      fleet,
      apiDocumentation,
      new ConversationSearchService(messages),
      workspaceActivity,
      monitors,
      new FileSystemWorkspaceImages(workspaces),
    ),
    workspaces,
    monitors,
  );
  const attachmentRepository = new PostgresAttachmentRepository(database);
  // Uploads land in the same volume folders the teammate pods mount, at the paths they see.
  const attachmentFiles = new WorkspaceAttachmentFiles(
    config.agentsDirectory,
    workspaceFiles,
  );
  subagents = new SubagentService(
    conversations,
    new PiSubagentArchives(workspaces),
  );
  const voice = await createVoiceRuntime(config.voice, agents, (message) =>
    reportWarning(message),
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
    credentialGrants,
    credentialRollouts,
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
    attachments: new AttachmentService(
      agents,
      attachmentRepository,
      attachmentFiles,
    ),
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
    artifacts: new ArtifactLibraryService(artifactGateway, credentialGrants),
    workers,
    workspaces: workspaceInstances,
    workspaceActivity,
    voice: voice.uploads,
    voiceStreams: voice.streams,
    telemetry: createTelemetryReader(config.telemetry),
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
    () => {
      const message =
        "An update summary could not complete; the update's source remains available.";
      app.log.warn(message);
      recordWarning(message);
    },
  );
  const credentialSync = new CredentialSyncScheduler(credentialRollouts, () =>
    app.log.warn(
      "Credentials couldn't be compared with apps; Everything will retry.",
    ),
  );
  const providerChecks = new ProviderCheckScheduler(
    new PostgresProviderCheckRepository(database),
    providers,
    () => {
      const message =
        "Automatic provider checks could not complete; scheduling will retry.";
      app.log.warn(message);
      recordWarning(message);
    },
  );
  const attachmentExpiry = new AttachmentExpiryScheduler(
    new AttachmentExpiry(attachmentRepository, attachmentFiles),
    () => {
      const message =
        "Expired attachments couldn't be removed; removal will retry.";
      app.log.warn(message);
      recordWarning(message);
    },
  );
  // Waiting on the speech services would hold shutdown open, so transcriptions and streams stop first.
  app.addHook("preClose", async () => voice.close());
  app.addHook("onClose", async () => {
    await summaries.close();
    await providerChecks.close();
    await credentialSync.close();
    await attachmentExpiry.close();
    await monitors.close();
    await conversations.close();
    await workspaces.close();
    await fleetClientAddress?.close();
    await fleet.close();
    await ssh.close();
    await database.destroy();
    // Last, so what shutting down recorded is exported too, within the export deadline.
    await activeTelemetry()?.shutdown();
  });
  closeOnTermination(app);
  await app.listen({ host: "0.0.0.0", port: config.port });
  summaries.start();
  providerChecks.start();
  credentialSync.start();
  attachmentExpiry.start();
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
