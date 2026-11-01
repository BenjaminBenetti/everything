import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthenticatedTransport } from "../../http/adapter/authenticated-transport.js";
import { HttpRequestError } from "../../http/model/http-request-error.js";
import { HttpAttachmentClient } from "../adapter/http-attachment-client.js";
import { HttpConversationClient } from "../adapter/http-conversation-client.js";

const agentId = "11111111-1111-4111-8111-111111111111";

/** A transport over a fake fetch that records each request and answers with `respond`. */
function recording(respond: (path: string, options: RequestInit) => Response) {
  const requests: { path: string; options: RequestInit }[] = [];
  const transport = createAuthenticatedTransport(
    async (input, options = {}) => {
      requests.push({ path: String(input), options });
      return respond(String(input), options);
    },
  );
  return { requests, transport };
}

test("uploads send only the name and size, then raw parts with their offset", async () => {
  const { requests, transport } = recording((_path, options) =>
    options.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ id: "upload", attachments: [] }),
  );
  const client = new HttpAttachmentClient(transport);
  await client.create(agentId, { name: "C:\\fakepath\\photo.png", size: 3 });
  const part = new Blob([new Uint8Array([1, 2, 3])]);
  await client.upload(agentId, "upload", 0, part, new AbortController().signal);
  await client.unsent(agentId);
  assert.equal(await client.remove(agentId, "upload"), undefined);
  assert.deepEqual(
    requests.map(({ path, options }) => [path, options.method ?? "GET"]),
    [
      [`/v1/agents/${agentId}/attachments`, "POST"],
      [`/v1/agents/${agentId}/attachments/upload/content?offset=0`, "POST"],
      [`/v1/agents/${agentId}/attachments`, "GET"],
      [`/v1/agents/${agentId}/attachments/upload`, "DELETE"],
    ],
  );
  assert.equal(
    requests[0]!.options.body,
    JSON.stringify({ name: "C:\\fakepath\\photo.png", size: 3 }),
  );
  assert.equal(requests[1]!.options.body, part);
  assert.equal(
    new Headers(requests[1]!.options.headers).get("Content-Type"),
    "application/octet-stream",
  );
  assert.equal(requests[1]!.options.credentials, "same-origin");
  assert.equal(
    client.contentUrl(agentId, "a/../b"),
    `/v1/agents/${agentId}/attachments/a%2F..%2Fb/content`,
  );
});

test("text-only messages keep their original body, and files can be sent alone", async () => {
  const { requests, transport } = recording(() =>
    Response.json({ messageId: "m", runId: "r" }, { status: 202 }),
  );
  const client = new HttpConversationClient(transport);
  await client.send(agentId, { text: "Hello" });
  await client.send(agentId, { text: "  ", attachmentIds: ["a", "b"] });
  await client.send(agentId, { text: "Look", attachmentIds: [] });
  assert.deepEqual(
    requests.map((request) => request.options.body),
    [
      JSON.stringify({ text: "Hello" }),
      JSON.stringify({ attachmentIds: ["a", "b"] }),
      JSON.stringify({ text: "Look" }),
    ],
  );
});

test("a file that is no longer available explains how to recover", async () => {
  const { transport } = recording(() =>
    Response.json(
      { code: "ATTACHMENT_UNAVAILABLE", message: "server detail" },
      { status: 409 },
    ),
  );
  await assert.rejects(
    new HttpConversationClient(transport).send(agentId, {
      attachmentIds: ["gone"],
    }),
    (error) =>
      error instanceof HttpRequestError &&
      error.code === "ATTACHMENT_UNAVAILABLE" &&
      /Remove it or attach it again/.test(error.message) &&
      !/server detail/.test(error.message),
  );
});
