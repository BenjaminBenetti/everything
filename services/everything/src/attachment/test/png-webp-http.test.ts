import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import type { AttachmentUpload } from "@everything/conversation-contracts/attachment";
import { attachmentLimits } from "../model/attachment.js";
import { attachmentStagingFolder } from "../model/attachment-file.js";
import { imageDimensions } from "../../workspace/model/image-format.js";
import { FileSystemWorkspaceImages } from "../../workspace/adapter/file-system-workspace-images.js";
import { imageTools } from "../../runtime/tool/image-tools.js";
import { createAttachmentGateway, e2eAgentId } from "./attachment-gateway.js";
import { screenshot } from "./synthetic-screenshot.js";

test("actual TCP HTTP upload → encoded file → send/history/download → real image_view; input progress stays original", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "everything-png-http-"));
  const gateway = await createAttachmentGateway(root, "http://127.0.0.1:5184");
  const origin = await gateway.app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await gateway.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const auth = { authorization: "Bearer attachments-e2e-token" };
  const base = "/v1/agents/" + e2eAgentId;
  const input = await screenshot(1280, 720, 64);
  assert.ok(
    input.length > attachmentLimits.chunkBytes,
    "Real multi-part PNG fixture",
  );
  let response = await fetch(origin + base + "/attachments", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      name: "clipboard screenshot.png",
      size: input.length,
    }),
  });
  assert.equal(response.status, 201);
  let upload = (await response.json()) as AttachmentUpload;
  assert.equal(upload.inputSize, input.length);
  for (let offset = 0; offset < input.length;) {
    const chunk = input.subarray(offset, offset + attachmentLimits.chunkBytes);
    response = await fetch(
      origin + base + "/attachments/" + upload.id + "/content?offset=" + offset,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/octet-stream" },
        body: Uint8Array.from(chunk).buffer,
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    upload = (await response.json()) as AttachmentUpload;
    offset += chunk.length;
    assert.equal(upload.received, offset);
    assert.equal(upload.inputSize, input.length);
    if (offset < input.length) {
      assert.equal(upload.status, "uploading");
      assert.equal(upload.size, input.length);
    }
  }
  assert.equal(upload.status, "ready");
  assert.equal(upload.name, "clipboard screenshot.webp");
  assert.equal(upload.mediaType, "image/webp");
  assert.ok(upload.path.endsWith("/clipboard_screenshot.webp"));
  assert.ok(upload.size < upload.received);
  const local = path.join(
    gateway.volume,
    path.posix.relative("/workspace", upload.path),
  );
  const encoded = await readFile(local);
  assert.equal(encoded.length, upload.size);
  assert.deepEqual(imageDimensions(encoded, "image/webp"), {
    width: 1280,
    height: 720,
  });
  assert.deepEqual(await readdir(path.dirname(local)), [
    "clipboard_screenshot.webp",
  ]);
  assert.deepEqual(
    await readdir(path.join(gateway.volume, attachmentStagingFolder)),
    [],
  );

  response = await fetch(
    origin + base + "/attachments/" + upload.id + "/content",
    { headers: auth },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(Number(response.headers.get("content-length")), encoded.length);
  assert.match(
    response.headers.get("content-disposition")!,
    /inline;.*clipboard screenshot.webp/,
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), encoded);
  response = await fetch(origin + base + "/messages", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      text: "Inspect this screenshot",
      attachmentIds: [upload.id],
    }),
  });
  assert.equal(response.status, 202, await response.clone().text());
  const promptPath = path.join(gateway.evidence, "initial-model-input-1.txt");
  let prompt: string | undefined;
  for (let attempt = 0; attempt < 100 && prompt === undefined; attempt++) {
    prompt = await readFile(promptPath, "utf8").catch(() => undefined);
    if (prompt === undefined) await setTimeout(10);
  }
  assert.ok(prompt);
  assert.ok(prompt.includes(upload.path));
  assert.ok(prompt.length < 4096);
  assert.doesNotMatch(prompt, /data:image|base64|iVBORw0KGgo/);
  assert.ok(!prompt.includes(encoded.toString("base64").slice(0, 80)));
  response = await fetch(origin + base + "/messages", { headers: auth });
  assert.equal(response.status, 200);
  const history = (await response.json()) as {
    messages: {
      attachments: {
        id: string;
        name: string;
        path: string;
        size: number;
        mediaType: string;
      }[];
    }[];
  };
  const saved = history.messages
    .flatMap((message) => message.attachments)
    .find((file) => file.id === upload.id);
  assert.deepEqual(saved, {
    id: upload.id,
    name: upload.name,
    path: upload.path,
    size: upload.size,
    kind: "image",
    mediaType: "image/webp",
  });
  const images = new FileSystemWorkspaceImages(gateway.workspaces);
  const [tool] = imageTools(images, e2eAgentId);
  // This temporary volume mirrors /workspace; use the tool's supported teammate-relative spelling.
  const relative = path.posix.relative("/workspace/" + e2eAgentId, upload.path);
  const result = await tool!.execute(
    "view",
    { path: relative },
    undefined,
    undefined,
    { model: { input: ["text", "image"] } } as never,
  );
  assert.match(
    (result.content[0] as { text: string }).text,
    /image\/webp, 1280×720/,
  );
  assert.equal(result.content[1]?.type, "image");
  assert.equal(
    (
      await fetch(origin + base + "/attachments/" + upload.id, {
        method: "DELETE",
        headers: auth,
      })
    ).status,
    409,
    "Claimed converted files are retained",
  );
});
