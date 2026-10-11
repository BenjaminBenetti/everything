import { KeycloakPasswordAuthentication } from "@everything/security/password-grant";
import { SessionCipher } from "@everything/security/session-cipher";
import { SessionService } from "../../session/service/session-service.js";
import { PostgresSessionRepository } from "../../session/repository/postgres-session-repository.js";
import type { FastifyInstance } from "fastify";
import { createKeycloakTokenVerifier } from "@everything/security/keycloak";
import { PostgresAgentRepository } from "../../agent/repository/postgres-agent-repository.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import { AgentService } from "../../agent/service/agent-service.js";
import { AgentNamingService } from "../../agent/service/agent-naming-service.js";
import { PostgresMessageRepository } from "../../conversation/repository/postgres-message-repository.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import { createApplicationDatabase } from "../../persistence/factory/application-database.js";
import { PiSessionFactory } from "../../runtime/adapter/pi-session-factory.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { loadApplicationConfig } from "../config/application-config.js";
import { createHttpApplication } from "../factory/http-application.js";

/** Assemble concrete adapters once at the process boundary and own their lifecycle. */
async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadApplicationConfig(process.env);
  const verifier = createKeycloakTokenVerifier({
    jwksUrl: config.jwksUrl,
    issuer: config.issuer,
    audience: config.audience,
  });
  const database = createApplicationDatabase(config);
  await database.initialize();
  await database.runMigrations();
  const models = await createModelRuntime(config.stateDirectory);
  const agentRepository = new PostgresAgentRepository(database);
  const agents = new AgentService(agentRepository);
  const workspaces = new FileSystemWorkspaces(config.agentsDirectory);
  const conversations = new ConversationService(
    agents,
    new PostgresMessageRepository(database),
    new PiSessionFactory(models, workspaces),
    workspaces,
  );
  const app = await createHttpApplication({
    agents,
    names: new AgentNamingService(agentRepository),
    removal: conversations,
    conversations,
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
    },
  });
  app.addHook("onClose", async () => {
    await conversations.close();
    await database.destroy();
  });
  closeOnTermination(app);
  await app.listen({ host: "0.0.0.0", port: config.port });
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
