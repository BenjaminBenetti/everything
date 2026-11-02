import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiDocumentationService } from "../../api-documentation/service/api-documentation-service.js";
import {
  createHttpApplication,
  type HttpDependencies,
} from "../../application/factory/http-application.js";
import { ConversationService } from "../../conversation/service/conversation-service.js";
import type { ConversationMessageStore } from "../../conversation/interface/message-repository.js";
import type { ConversationMessage } from "../../conversation/model/message.js";
import type { AgentSessionFactory } from "../../runtime/interface/agent-session.js";
import { sendMessageTool } from "../../runtime/tool/send-message-tool.js";
import {
  agents as ownedAgents,
  agentId,
  otherAgentId,
  strangerAgentId,
} from "../../attachment/test/attachment-fixtures.js";
import { screenshot } from "../../attachment/test/synthetic-screenshot.js";
import { FileSystemWorkspaces } from "../service/file-system-workspaces.js";
import { FileSystemWorkspaceImageContent } from "../adapter/file-system-workspace-image-content.js";
import { WorkspaceImageContentService } from "../service/workspace-image-content-service.js";
export { agentId, otherAgentId, strangerAgentId };

/** Fail loudly on any unrelated backend operation; no provider or credential implementation exists here. */
function unused<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, key) => () =>
        assert.fail(`Unused fixture operation: ${String(key)}`),
    },
  ) as T;
}

/** Deliberately delivered main-session Markdown, plus controls that must never request image bytes. */
export function workspaceMarkdown(id: string): string {
  return `## Workspace image
![Workspace chart](plots/chart.png)
![Absolute image](</workspace/${id}/plots/Quarterly chart α.png>)

Plain path: plots/plain-only.png

[Download](plots/link-only.png)

\`![Code image](plots/code-only.png)\`

<img src="plots/html-only.png">

![Missing chart](plots/missing.png)

A footnote[^file].

[^file]: Files stay in this teammate’s workspace.`;
}

/** Real production HTTP/conversation/delivery and real files; auth, owned records and model are fixtures. */
export async function createWorkspaceImageGateway(
  root: string,
  origin: string,
) {
  const volume = path.join(root, "volume");
  await mkdir(volume);
  const workspaces = new FileSystemWorkspaces(volume);
  await workspaces.createShared();
  for (const [id, width] of [
    [agentId, 640],
    [otherAgentId, 480],
    [strangerAgentId, 320],
  ] as const) {
    const folder = path.join(workspaces.directory(id), "plots");
    await mkdir(folder, { recursive: true });
    const bytes = await screenshot(width, 240, 8);
    for (const name of [
      "chart.png",
      "Quarterly chart α.png",
      "plain-only.png",
      "link-only.png",
      "code-only.png",
      "html-only.png",
    ])
      await writeFile(path.join(folder, name), bytes, { flag: "wx" });
  }
  const agents = {
    async get(owner: string, id: string) {
      const agent = await ownedAgents.get(owner, id);
      return {
        ...agent,
        name: id === agentId ? "Avery" : "Blake",
        inference: {
          provider: "chatgpt" as const,
          model: "fixture-text-only",
          effort: "high" as const,
        },
      };
    },
    async delete() {
      assert.fail("No deletion in image fixture");
    },
  };
  const histories = new Map<string, ConversationMessage[]>();
  const history = (id: string) => {
    if (!histories.has(id)) histories.set(id, []);
    return histories.get(id)!;
  };
  const store: ConversationMessageStore = {
    async append(scope, role, text) {
      await agents.get(scope.ownerId, scope.agentId);
      const message = {
        id: randomUUID(),
        role,
        text,
        createdAt: new Date().toISOString(),
        attachments: [],
      };
      history(scope.agentId).push(message);
      return message;
    },
    async deliver(scope, text) {
      return this.append(scope, "assistant", text);
    },
    async page(scope) {
      await agents.get(scope.ownerId, scope.agentId);
      return { messages: history(scope.agentId), nextCursor: null };
    },
  };
  const sessions: AgentSessionFactory = {
    async create(agent, deliver) {
      return {
        id: "fixture-session",
        compacting: false,
        compactionStartedAt: null,
        typing: false,
        lastToolName: "send_message",
        async prompt() {
          const tool = sendMessageTool(deliver);
          await tool.execute(
            "fixture-call",
            { text: workspaceMarkdown(agent.id) },
            undefined,
            undefined,
            {} as never,
          );
        },
        async abort() {},
        async dispose() {},
      };
    },
  };
  const dependencies: HttpDependencies = {
    ...unused<HttpDependencies>(),
    apiDocumentation: new ApiDocumentationService(),
    publicOrigin: origin,
    chatGptRedirectUri: origin + "/v1/providers/chatgpt/callback",
    verifier: {
      async verify(token) {
        if (!["workspace-image-token", "stranger-token"].includes(token))
          throw new Error("Invalid synthetic token");
        return { subject: token === "stranger-token" ? "stranger" : "owner" };
      },
    },
    sessions: {
      ...unused<HttpDependencies["sessions"]>(),
      resolve: async (handle) =>
        handle === "workspace-image-session"
          ? {
              accessToken: "workspace-image-token",
              profile: { subject: "owner", displayName: "Image tester" },
            }
          : undefined,
    },
    conversations: new ConversationService(agents, store, sessions, {
      async remove() {},
    }),
    workspaceImages: new WorkspaceImageContentService(
      agents,
      new FileSystemWorkspaceImageContent(workspaces),
    ),
    keys: unused(),
    credentialGrants: unused(),
    credentialRollouts: unused(),
    providers: unused(),
    models: unused(),
    agents: unused(),
    agentActivity: unused(),
    profiles: unused(),
    removal: unused(),
    attachments: unused(),
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
  return { app, volume, workspaces, histories };
}
