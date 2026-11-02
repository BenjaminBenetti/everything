import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiDocumentationService } from "../../api-documentation/service/api-documentation-service.js";
import {
  createHttpApplication,
  type HttpDependencies,
} from "../../application/factory/http-application.js";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { ConversationMessageStore } from "../../conversation/interface/message-repository.js";
import type { ConversationMessage } from "../../conversation/model/message.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import type { AgentSessionFactory } from "../../runtime/interface/agent-session.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { WorkspaceAttachmentFiles } from "../adapter/workspace-attachment-files.js";
import { AttachmentUnavailableError } from "../error/attachment-errors.js";
import { representMessageAttachment } from "../presenter/attachment-presenter.js";
import { AttachmentService } from "../service/attachment-service.js";
import { MemoryAttachments } from "./attachment-fixtures.js";

/** The teammate the browser test opens. */
export const e2eAgentId = "5d0c6a52-8b8e-4c55-9c1a-3f1d2e7b9a10";
const ownerId = "attachments-e2e-owner";

/** Every operation the chat page doesn't use through this gateway fails loudly. */
function unused<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => () =>
        assert.fail(`Unused: ${String(property)}`),
    },
  ) as T;
}

/** Real HTTP/attachment/conversation/codec fixture; only auth, records and model are synthetic. */
export async function createAttachmentGateway(root: string, origin: string) {
  // A fresh volume for each run: the teammate's workspace folders, the shared folder, and evidence.
  const volume = path.join(root, "workspace-volume");
  const evidence = path.join(root, "evidence");
  await mkdir(evidence, { recursive: true });
  const workspaces = new FileSystemWorkspaces(volume);
  await workspaces.createShared();
  await mkdir(workspaces.directory(e2eAgentId), { recursive: true });

  const teammate: AgentDefinition = {
    id: e2eAgentId,
    ownerId,
    name: "Avery",
    systemPrompt: "Help with project files.",
    avatarId: "avatar-03",
    inference: { provider: "anthropic", model: "mocked-model", effort: "high" },
    createdAt: "2026-10-30T09:00:00.000Z",
  };
  const agents: Pick<AgentCatalog, "get" | "delete"> = {
    async get(owner, id) {
      if (owner !== ownerId || id !== e2eAgentId)
        throw new AgentNotFoundError();
      return teammate;
    },
    async delete() {
      assert.fail("Teammates are not deleted in this test");
    },
  };

  // In-memory records in place of PostgreSQL, applying the same scope and claim rules.
  const records = new MemoryAttachments({ [e2eAgentId]: ownerId });
  const messages: ConversationMessage[] = [];
  const store: ConversationMessageStore = {
    async append(scope, role, text, attachmentIds = []) {
      const claimed = [];
      for (const id of attachmentIds) {
        const attachment = await records.getById(scope, id);
        if (attachment?.status !== "ready" || attachment.messageId)
          throw new AttachmentUnavailableError();
        claimed.push(attachment);
      }
      const message: ConversationMessage = {
        id: randomUUID(),
        role,
        text,
        createdAt: new Date().toISOString(),
        attachments: claimed.map(representMessageAttachment),
      };
      records.claim(attachmentIds, message.id);
      messages.push(message);
      return message;
    },
    async deliver(_scope, text) {
      const message: ConversationMessage = {
        id: randomUUID(),
        role: "assistant",
        text,
        createdAt: new Date().toISOString(),
        attachments: [],
      };
      messages.push(message);
      return message;
    },
    async page() {
      return { messages: messages.slice(-100), nextCursor: null };
    },
  };

  // The mocked model: it records exactly what the teammate's turn receives and replies once.
  let turns = 0;
  const sessions: AgentSessionFactory = {
    async create(_agent, sendMessage) {
      return {
        id: "mocked-session",
        compacting: false,
        compactionStartedAt: null,
        lastToolName: "send_message",
        typing: false,
        async prompt(input) {
          turns++;
          await writeFile(
            path.join(evidence, `initial-model-input-${turns}.txt`),
            input,
          );
          const paths = input.match(/\/workspace\/[^\s]+/g) ?? [];
          await sendMessage(
            paths.length
              ? `(Mocked model reply.) I received ${paths.length} file paths and no file contents. I'll open them with my tools when I need them:\n${paths.map((item) => `- \`${item}\``).join("\n")}`
              : "(Mocked model reply.) Got it.",
          );
        },
        async abort() {},
        async dispose() {},
      };
    },
  };

  const files = new WorkspaceAttachmentFiles(volume, workspaces);
  const dependencies: HttpDependencies = {
    apiDocumentation: new ApiDocumentationService(),
    verifier: {
      verify: async (token) => {
        if (token !== "attachments-e2e-token") throw new Error("invalid");
        return { subject: ownerId };
      },
    },
    sessions: {
      ...unused<HttpDependencies["sessions"]>(),
      resolve: async (handle) =>
        handle === "attachments-e2e-session"
          ? {
              accessToken: "attachments-e2e-token",
              profile: { subject: ownerId, displayName: "Attachment tester" },
            }
          : undefined,
    },
    publicOrigin: origin,
    chatGptRedirectUri: "http://127.0.0.1:8080/v1/providers/chatgpt/callback",
    keys: unused(),
    credentialGrants: unused(),
    credentialRollouts: unused(),
    providers: unused(),
    models: unused(),
    agents: unused(),
    agentActivity: unused(),
    profiles: unused(),
    removal: unused(),
    conversations: new ConversationService(agents, store, sessions, {
      async remove() {},
    }),
    attachments: new AttachmentService(agents, records, files),
    subagents: unused(),
    updates: unused(),
    upgrades: unused(),
    artifacts: unused(),
    workers: unused(),
    generalSettings: unused(),
    teammateOrder: unused(),
    workspaces: unused(),
    workspaceActivity: unused(),
    voice: unused(),
    voiceStreams: unused(),
    telemetry: unused(),
    readiness: async () => {},
  };
  const app = await createHttpApplication(dependencies);

  return { app, root, volume, evidence, workspaces, records, messages };
}
