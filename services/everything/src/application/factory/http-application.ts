import type { KeyOperations } from "../../key/interface/key-operations.js";
import { keyController } from "../../key/controller/key-controller.js";
import { credentialController } from "../../credential/controller/credential-controller.js";
import type { CredentialGrants } from "../../credential/service/credential-grants.js";
import type { CredentialRollouts } from "../../credential/service/credential-rollouts.js";
import fastifyCookie from "@fastify/cookie";
import type { SessionOperations } from "../../session/interface/session-operations.js";
import { SessionCookie } from "../../session/handler/session-cookie.js";
import { sessionController } from "../../session/controller/session-controller.js";
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { requireAuthentication } from "@everything/security/fastify";
import type { TokenVerifier } from "@everything/security/token-verifier";
import { agentController } from "../../agent/controller/agent-controller.js";
import { agentActivityController } from "../../agent/controller/agent-activity-controller.js";
import type { AgentActivity } from "../../agent/interface/agent-activity.js";
import { artifactController } from "../../artifact/controller/artifact-controller.js";
import type { ArtifactLibrary } from "../../artifact/interface/artifact-library.js";
import { agentEditingController } from "../../agent/controller/agent-editing-controller.js";
import type { AgentEditing } from "../../agent/interface/agent-editing.js";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type { AgentRemoval } from "../../agent/interface/agent-removal.js";
import { conversationController } from "../../conversation/controller/conversation-controller.js";
import { attachmentController } from "../../attachment/controller/attachment-controller.js";
import type { AttachmentOperations } from "../../attachment/interface/attachment-operations.js";
import type { ConversationOperations } from "../../conversation/interface/conversation-operations.js";
import {
  healthController,
  type ReadinessCheck,
} from "../../health/controller/health-controller.js";
import { strictRequestValidation } from "../../http/config/request-validation.js";
import { requestBodyLimit } from "../../http/config/request-limits.js";
import { errorHandler } from "@everything/errors/fastify";
import { identityController } from "../../identity/controller/identity-controller.js";
import { providerController } from "../../provider/controller/provider-controller.js";
import { chatGptCallbackController } from "../../provider/controller/chatgpt-callback-controller.js";
import type { ProviderConnections } from "../../provider/interface/provider-connections.js";
import type { ProviderModels } from "../../provider/interface/provider-models.js";
import { providerModelController } from "../../provider/controller/provider-model-controller.js";
import { settingsController } from "../../settings/controller/settings-controller.js";
import { generalSettingsController } from "../../settings/controller/general-settings-controller.js";
import type { GeneralSettingsOperations } from "../../settings/interface/general-settings.js";
import { teammateOrderController } from "../../settings/controller/teammate-order-controller.js";
import type { TeammateOrderOperations } from "../../settings/interface/teammate-order.js";
import type { WorkerSettingsOperations } from "../../settings/interface/worker-settings.js";
import type { WorkspaceInstances } from "../../workspace/interface/workspace-instances.js";
import { workspaceInstanceController } from "../../workspace/controller/workspace-instance-controller.js";
import type { WorkspaceActivityReader } from "../../workspace/interface/workspace-activity.js";
import { workspaceActivityController } from "../../workspace/controller/workspace-activity-controller.js";
import type { UpdateOperations } from "../../update/interface/update-operations.js";
import type { UpgradeOperations } from "../../upgrade/interface/upgrade-operations.js";
import { upgradeController } from "../../upgrade/controller/upgrade-controller.js";
import { updateController } from "../../update/controller/update-controller.js";
import type { SubagentOperations } from "../../subagent/interface/subagent-operations.js";
import { subagentController } from "../../subagent/controller/subagent-controller.js";
import { registerApiDocumentation } from "../../api-documentation/adapter/fastify-api-documentation.js";
import { apiDocumentationController } from "../../api-documentation/controller/api-documentation-controller.js";
import type {
  ApiDocumentationReader,
  ApiDocumentationPublisher,
} from "../../api-documentation/interface/api-documentation.js";
import type { VoiceOperations } from "../../voice/interface/voice-operations.js";
import type { VoiceStreamOperations } from "../../voice/interface/voice-stream-operations.js";
import {
  registerVoiceWebSocket,
  voiceController,
} from "../../voice/controller/voice-controller.js";
import type { TelemetryReader } from "../../telemetry/interface/telemetry-reader.js";
import { telemetryController } from "../../telemetry/controller/telemetry-controller.js";
import {
  bindAuthenticatedRequest,
  registerRequestTelemetry,
} from "../../telemetry/handler/request-telemetry.js";

/** Use cases and transport settings supplied by the composition root. */
export interface HttpDependencies {
  readonly apiDocumentation: ApiDocumentationReader & ApiDocumentationPublisher;
  readonly verifier: TokenVerifier;
  readonly sessions: SessionOperations;
  readonly publicOrigin: string;
  readonly chatGptRedirectUri: string;
  readonly keys: KeyOperations;
  readonly credentialGrants: Pick<
    CredentialGrants,
    "usage" | "attach" | "detach"
  >;
  readonly credentialRollouts: Pick<CredentialRollouts, "deliver" | "revoke">;
  readonly providers: ProviderConnections;
  readonly models: Pick<ProviderModels, "list">;
  readonly agents: Omit<AgentCatalog, "delete">;
  readonly agentActivity: AgentActivity;
  readonly profiles: AgentEditing;
  readonly removal: AgentRemoval;
  readonly conversations: ConversationOperations;
  readonly attachments: AttachmentOperations;
  readonly subagents: SubagentOperations;
  readonly updates: UpdateOperations;
  readonly upgrades: UpgradeOperations;
  readonly artifacts: ArtifactLibrary;
  readonly workers: WorkerSettingsOperations;
  readonly generalSettings: GeneralSettingsOperations;
  readonly teammateOrder: TeammateOrderOperations;
  readonly workspaces: WorkspaceInstances;
  readonly workspaceActivity: WorkspaceActivityReader;
  readonly voice: VoiceOperations;
  readonly voiceStreams: VoiceStreamOperations;
  readonly telemetry: TelemetryReader;
  readonly readiness: ReadinessCheck;
}

/** Compose transport protections and routes; TLS terminates at the cluster's ingress. */
export async function createHttpApplication(
  dependencies: HttpDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    // Client addresses for rate limiting and logs come from the ingress's forwarded headers.
    trustProxy: true,
    bodyLimit: requestBodyLimit,
    requestTimeout: 15_000,
    logger: {
      serializers: {
        /** OAuth codes belong only in the protected callback flow, never access logs. */
        req(request) {
          return {
            method: request.method,
            url: request.url.split("?")[0] ?? "",
            remoteAddress: request.ip,
          };
        },
      },
      redact: [
        "req.body.password",
        "req.body.apiKey",
        "req.body.material",
        "req.body.callback",
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
    },
    ajv: strictRequestValidation,
  });
  await app.register(helmet);
  // Before every route, so refused upgrades are cleaned up whichever hook refuses them.
  await registerVoiceWebSocket(app);
  await app.register(fastifyCookie);
  // Only routes that opt in are limited: those reachable without authentication.
  await app.register(rateLimit, { global: false });
  app.setErrorHandler(errorHandler);
  await registerRequestTelemetry(app);
  await healthController(app, dependencies.readiness);
  await chatGptCallbackController(
    app,
    dependencies.publicOrigin,
    dependencies.chatGptRedirectUri,
  );
  const cookie = new SessionCookie(dependencies.publicOrigin);
  await app.register(
    async (scope) => sessionController(scope, dependencies.sessions, cookie),
    { prefix: "/v1" },
  );
  await app.register(protectedApi(dependencies, cookie), { prefix: "/v1" });
  return app;
}

/** Routes accept verified bearer tokens or browser sessions and must never be cached. */
function protectedApi(
  dependencies: HttpDependencies,
  cookie: SessionCookie,
): FastifyPluginAsync {
  return async (scope) => {
    await registerApiDocumentation(scope, dependencies.apiDocumentation);
    scope.addHook("onRequest", async (request) => {
      cookie.protectMutation(request);
    });
    requireAuthentication(
      scope,
      dependencies.verifier,
      async (request) =>
        (await dependencies.sessions.resolve(cookie.read(request)))
          ?.accessToken,
    );
    // After authentication, so each request's trace is attributed to its verified owner only.
    scope.addHook("onRequest", async (request) => {
      bindAuthenticatedRequest(request);
    });
    scope.addHook("onSend", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });
    await identityController(scope);
    await apiDocumentationController(scope, dependencies.apiDocumentation);
    await keyController(scope, dependencies.keys, {
      rollouts: dependencies.credentialRollouts,
      grants: dependencies.credentialGrants,
    });
    await credentialController(scope, dependencies.credentialGrants);
    await providerController(scope, dependencies.providers);
    await providerModelController(scope, dependencies.models);
    await conversationController(scope, dependencies.conversations);
    await attachmentController(scope, dependencies.attachments);
    await subagentController(scope, dependencies.subagents);
    await updateController(scope, dependencies.updates);
    await upgradeController(scope, dependencies.upgrades);
    await agentController(scope, dependencies.agents, dependencies.removal);
    await agentActivityController(scope, dependencies.agentActivity);
    await agentEditingController(scope, dependencies.profiles);
    await artifactController(scope, dependencies.artifacts, (request) =>
      cookie.requireSignedInUser(request),
    );
    await settingsController(scope, dependencies.workers);
    await generalSettingsController(scope, dependencies.generalSettings);
    await teammateOrderController(scope, dependencies.teammateOrder);
    await workspaceInstanceController(scope, dependencies.workspaces);
    await workspaceActivityController(scope, dependencies.workspaceActivity);
    await telemetryController(scope, dependencies.telemetry);
    await voiceController(
      scope,
      dependencies.voice,
      dependencies.voiceStreams,
      (request) => cookie.protectUpgrade(request),
    );
  };
}
