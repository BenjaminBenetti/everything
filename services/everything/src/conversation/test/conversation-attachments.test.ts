import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageAttachment } from "@everything/conversation-contracts/attachment";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import { AttachmentUnavailableError } from "../../attachment/error/attachment-errors.js";
import type { AgentSessionFactory } from "../../runtime/interface/agent-session.js";
import { EmptyMessageError } from "../error/conversation-errors.js";
import type { ConversationMessageStore } from "../interface/message-repository.js";
import { ConversationService } from "../service/conversation-service.js";

const agentId = "11111111-1111-4111-8111-111111111111";

/** One uploaded file of each kind, as the message repository returns them once claimed. */
const uploaded: Record<string, MessageAttachment> = {
  image: {
    id: "image",
    name: "diagram.png",
    size: 2_000_000,
    kind: "image",
    mediaType: "image/png",
    path: `/workspace/${agentId}/attachments/image/diagram.png`,
  },
  data: {
    id: "data",
    name: "dump.bin",
    size: 3,
    kind: "binary",
    mediaType: "application/octet-stream",
    path: `/workspace/${agentId}/attachments/data/dump.bin`,
  },
};

/** A conversation whose model session records every prompt it is given. */
function fixture() {
  const prompts: string[] = [];
  const appended: { text: string; attachmentIds: readonly string[] }[] = [];
  const agents: Pick<AgentCatalog, "get" | "delete"> = {
    async get(ownerId, id) {
      return {
        id,
        ownerId,
        name: "Avery",
        systemPrompt: "Help.",
        avatarId: "avatar-01",
        inference: { provider: "anthropic", model: "m", effort: "high" },
        createdAt: "",
      };
    },
    async delete() {},
  };
  const messages: ConversationMessageStore = {
    async append(_scope, role, text, attachmentIds = []) {
      appended.push({ text, attachmentIds });
      return {
        id: `message-${appended.length}`,
        role,
        text,
        createdAt: "",
        attachments: attachmentIds.map((id) => {
          const attachment = uploaded[id];
          if (!attachment) throw new AttachmentUnavailableError();
          return attachment;
        }),
      };
    },
    async deliver(_scope, text) {
      return {
        id: "reply",
        role: "assistant",
        text,
        createdAt: "",
        attachments: [],
      };
    },
    async page() {
      return { messages: [], nextCursor: null };
    },
  };
  const sessions: AgentSessionFactory = {
    async create(_agent, sendMessage) {
      return {
        id: "session",
        compacting: false,
        compactionStartedAt: null,
        lastToolName: "send_message",
        typing: false,
        async prompt(text) {
          prompts.push(text);
          await sendMessage("Got it.");
        },
        async abort() {},
        async dispose() {},
      };
    },
  };
  const service = new ConversationService(agents, messages, sessions, {
    async remove() {},
  });
  return { service, prompts, appended };
}

/** Wait for the background turn to reach the session. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a message of only files is saved with them, and the turn receives paths, never contents", async () => {
  const { service, prompts, appended } = fixture();
  const receipt = await service.send("owner", agentId, {
    attachmentIds: ["image", "data"],
  });
  assert.equal(receipt.messageId, "message-1");
  assert.deepEqual(appended, [{ text: "", attachmentIds: ["image", "data"] }]);
  await settled();
  assert.equal(prompts.length, 1);
  const prompt = prompts[0]!;
  assert.ok(prompt.startsWith("<attachments>"));
  assert.match(prompt, new RegExp(uploaded.image!.path));
  assert.match(prompt, new RegExp(uploaded.data!.path));
  assert.match(prompt, /image_view/);
  assert.doesNotMatch(prompt, /base64|data:image/);
});

test("text with files keeps the text first, and text-only messages are unchanged", async () => {
  const { service, prompts } = fixture();
  await service.send("owner", agentId, {
    text: "What does this show?",
    attachmentIds: ["image"],
  });
  await settled();
  assert.ok(prompts[0]!.startsWith("What does this show?\n\n<attachments>"));
  await service.send("owner", agentId, { text: "Thanks!" });
  await settled();
  assert.equal(prompts[1], "Thanks!");
});

test("an empty message is refused, and an unavailable file fails the whole send", async () => {
  const { service, prompts, appended } = fixture();
  for (const input of [{}, { text: "  " }, { text: "", attachmentIds: [] }])
    await assert.rejects(
      service.send("owner", agentId, input as never),
      EmptyMessageError,
    );
  assert.deepEqual(appended, []);
  await assert.rejects(
    service.send("owner", agentId, { attachmentIds: ["image", "forged"] }),
    AttachmentUnavailableError,
  );
  await settled();
  assert.deepEqual(prompts, []);
});
