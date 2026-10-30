import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import {
  attachmentController,
  contentDisposition,
} from "../controller/attachment-controller.js";
import { attachmentLimits } from "../model/attachment.js";
import { AttachmentService } from "../service/attachment-service.js";
import {
  agentId,
  agents,
  MemoryAttachments,
  pngBytes,
  strangerAgentId,
  workspaceVolume,
} from "./attachment-fixtures.js";

const base = `/agents/${agentId}/attachments`;

/** Mount the controller as the application does, over a real service and temporary volume. */
async function fixture(context: TestContext) {
  const volume = await workspaceVolume(context);
  const app = authenticatedTestServer();
  await attachmentController(
    app,
    new AttachmentService(agents, new MemoryAttachments(), volume.files),
  );
  context.after(() => app.close());
  /** Create and fully upload a file in one part. */
  async function upload(name: string, bytes: Buffer) {
    const created = await app.inject({
      method: "POST",
      url: base,
      payload: { name, size: bytes.length },
    });
    assert.equal(created.statusCode, 201, created.body);
    const part = await app.inject({
      method: "POST",
      url: `${base}/${created.json().id}/content?offset=0`,
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    assert.equal(part.statusCode, 200, part.body);
    return part.json();
  }
  return { app, volume, upload };
}

test("files upload in parts, list while unsent, download with safe headers, and remove", async (context) => {
  const { app, volume } = await fixture(context);
  const bytes = Buffer.from("line one\nline two\n");
  const created = await app.inject({
    method: "POST",
    url: base,
    payload: { name: "notes.txt", size: bytes.length },
  });
  assert.equal(created.statusCode, 201);
  const upload = created.json();
  assert.equal(upload.status, "uploading");
  assert.equal(upload.received, 0);
  const first = await app.inject({
    method: "POST",
    url: `${base}/${upload.id}/content?offset=0`,
    headers: { "content-type": "application/octet-stream" },
    payload: bytes.subarray(0, 5),
  });
  assert.equal(first.json().received, 5);
  const retried = await app.inject({
    method: "POST",
    url: `${base}/${upload.id}/content?offset=0`,
    headers: { "content-type": "application/octet-stream" },
    payload: bytes.subarray(0, 5),
  });
  assert.equal(retried.statusCode, 409);
  assert.equal(retried.json().code, "ATTACHMENT_OFFSET_MISMATCH");
  const last = await app.inject({
    method: "POST",
    url: `${base}/${upload.id}/content?offset=5`,
    headers: { "content-type": "application/octet-stream" },
    payload: bytes.subarray(5),
  });
  assert.equal(last.statusCode, 200);
  assert.deepEqual(
    { status: last.json().status, kind: last.json().kind },
    { status: "ready", kind: "text" },
  );
  assert.deepEqual(await readFile(volume.local(last.json().path)), bytes);
  const listed = await app.inject({ url: base });
  assert.deepEqual(
    listed.json().attachments.map((item: { id: string }) => item.id),
    [upload.id],
  );
  const download = await app.inject({ url: `${base}/${upload.id}/content` });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, bytes);
  assert.equal(download.headers["content-type"], "application/octet-stream");
  assert.match(
    String(download.headers["content-disposition"]),
    /^attachment; filename="notes.txt"/,
  );
  assert.equal(
    download.headers["content-security-policy"],
    "default-src 'none'; sandbox",
  );
  assert.equal(download.headers["x-content-type-options"], "nosniff");
  assert.equal(download.headers["cross-origin-resource-policy"], "same-origin");
  const removed = await app.inject({
    method: "DELETE",
    url: `${base}/${upload.id}`,
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(
    (await app.inject({ url: `${base}/${upload.id}/content` })).statusCode,
    404,
  );
});

test("only sniffed raster images display inline; markup named as an image downloads", async (context) => {
  const { app, upload } = await fixture(context);
  const image = await upload("photo.png", pngBytes);
  const shown = await app.inject({ url: `${base}/${image.id}/content` });
  assert.equal(shown.headers["content-type"], "image/png");
  assert.match(String(shown.headers["content-disposition"]), /^inline;/);
  for (const [name, body] of [
    [
      "drawing.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    ],
    ["fake.png", "<html><script>alert(1)</script></html>"],
  ] as const) {
    const markup = await upload(name, Buffer.from(body));
    const response = await app.inject({ url: `${base}/${markup.id}/content` });
    assert.equal(response.headers["content-type"], "application/octet-stream");
    assert.match(
      String(response.headers["content-disposition"]),
      /^attachment;/,
    );
  }
});

test("file names can't inject headers, and the exact name is still offered", () => {
  const header = contentDisposition(
    "attachment",
    'report "final"\r\nSet-Cookie: x=1;.txt',
  );
  assert.doesNotMatch(header, /[\r\n]/);
  assert.equal(
    header,
    `attachment; filename="report _final___Set-Cookie_ x_1_.txt"; filename*=UTF-8''report%20%22final%22%0D%0ASet-Cookie%3A%20x%3D1%3B.txt`,
  );
  assert.equal(
    contentDisposition("inline", "résumé.png"),
    `inline; filename="r_sum_.png"; filename*=UTF-8''r%C3%A9sum%C3%A9.png`,
  );
});

test("browsers can't embed files from other sites, while bearer clients are unaffected", async (context) => {
  const { app, upload } = await fixture(context);
  const image = await upload("photo.png", pngBytes);
  const url = `${base}/${image.id}/content`;
  for (const site of ["cross-site", "same-site"])
    assert.equal(
      (await app.inject({ url, headers: { "sec-fetch-site": site } }))
        .statusCode,
      404,
      site,
    );
  for (const site of ["same-origin", "none"])
    assert.equal(
      (await app.inject({ url, headers: { "sec-fetch-site": site } }))
        .statusCode,
      200,
      site,
    );
  assert.equal(
    (
      await app.inject({
        url,
        headers: { "sec-fetch-site": "cross-site", authorization: "Bearer t" },
      })
    ).statusCode,
    200,
  );
});

test("requests can't choose paths, types, or oversized parts, and other teammates look missing", async (context) => {
  const { app } = await fixture(context);
  for (const payload of [
    { name: "x.txt", size: 1, path: "/workspace/other/x.txt" },
    { name: "x.txt", size: 1, mediaType: "image/png" },
    { name: " ", size: 1 },
    { name: "x.txt", size: attachmentLimits.maxFileBytes + 1 },
    { name: "x.txt", size: -1 },
    { name: "x".repeat(256), size: 1 },
  ]) {
    const response = await app.inject({ method: "POST", url: base, payload });
    assert.equal(
      response.statusCode,
      400,
      JSON.stringify(payload).slice(0, 60),
    );
  }
  const created = (
    await app.inject({
      method: "POST",
      url: base,
      payload: { name: "x.bin", size: 10 },
    })
  ).json();
  for (const offset of ["-1", "01", "1.5", "abc", "9999999999"]) {
    const response = await app.inject({
      method: "POST",
      url: `${base}/${created.id}/content?offset=${offset}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("x"),
    });
    assert.equal(response.statusCode, 400, offset);
  }
  const json = await app.inject({
    method: "POST",
    url: `${base}/${created.id}/content?offset=0`,
    payload: { bytes: "x" },
  });
  assert.equal(json.statusCode, 415);
  const oversized = await app.inject({
    method: "POST",
    url: `${base}/${created.id}/content?offset=0`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.alloc(attachmentLimits.maxChunkBytes + 1),
  });
  assert.equal(oversized.statusCode, 413);
  const tooMuch = await app.inject({
    method: "POST",
    url: `${base}/${created.id}/content?offset=0`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.alloc(11),
  });
  assert.equal(tooMuch.statusCode, 413);
  assert.equal(tooMuch.json().code, "ATTACHMENT_TOO_LARGE");
  assert.equal(
    (await app.inject({ url: `${base}/not-a-uuid/content` })).statusCode,
    400,
  );
  const foreign = await app.inject({
    url: `/agents/${strangerAgentId}/attachments/${created.id}/content`,
  });
  assert.equal(foreign.statusCode, 404);
  const anotherTeammate = await app.inject({
    method: "DELETE",
    url: `/agents/${strangerAgentId}/attachments/${created.id}`,
  });
  assert.equal(anotherTeammate.statusCode, 404);
});
