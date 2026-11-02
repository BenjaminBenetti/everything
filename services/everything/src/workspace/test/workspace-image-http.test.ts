import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  mkdir,
  writeFile,
  symlink,
  link,
  open,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { sendMessageTool } from "../../runtime/tool/send-message-tool.js";
import { test, type TestContext } from "node:test";
import sharp from "sharp";
import {
  createWorkspaceImageGateway,
  agentId,
  otherAgentId,
  strangerAgentId,
} from "./workspace-image-gateway.js";
import { png } from "../../attachment/test/attachment-fixtures.js";
import { maxImageBytes } from "../adapter/file-system-workspace-images.js";
import { FileSystemWorkspaceImageContent } from "../adapter/file-system-workspace-image-content.js";

/** Real TCP, authenticated production route and actual temporary file descriptors; no HTTP/file mocks. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-images-"));
  const gateway = await createWorkspaceImageGateway(
    root,
    "http://localhost:5193",
  );
  const origin = await gateway.app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await gateway.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const home = gateway.workspaces.directory(agentId);
  const get = (
    file: string,
    id = agentId,
    headers: Record<string, string> = {
      authorization: "Bearer workspace-image-token",
    },
  ) =>
    fetch(
      `${origin}/v1/agents/${id}/workspace-image?${new URLSearchParams({ path: file })}`,
      { headers },
    );
  return { ...gateway, origin, root, home, get };
}

test("real HTTP serves unchanged PNG/JPEG/GIF/WebP by signature, relative/absolute paths, Unicode and private headers", async (t) => {
  const f = await fixture(t);
  const before = await readdir(f.home);
  for (const [format, mediaType] of [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
  ] as const) {
    const bytes = await sharp({
      create: {
        width: 37,
        height: 19,
        channels: 4,
        background: { r: 12, g: 90, b: 160, alpha: 0.5 },
      },
    })
      .toFormat(format)
      .toBuffer();
    const name = `plots/real ${format} α.txt`;
    await writeFile(path.join(f.home, name), bytes);
    for (const requested of [
      name,
      "./" + name,
      path.join(f.home, name),
      `/workspace/${agentId}/${name}`,
    ]) {
      const response = await f.get(requested);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("content-type"), mediaType);
      assert.equal(
        Number(response.headers.get("content-length")),
        bytes.length,
      );
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("content-disposition"), "inline");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(
        response.headers.get("cross-origin-resource-policy"),
        "same-origin",
      );
      assert.match(response.headers.get("content-security-policy")!, /sandbox/);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    assert.deepEqual(await readFile(path.join(f.home, name)), bytes);
  }
  assert.deepEqual(
    await readdir(f.home),
    before,
    "No upload registry or copied directories",
  );
  assert.equal((await f.get("plots/chart.png", agentId, {})).status, 401);
  assert.equal(
    (
      await f.get("plots/chart.png", agentId, {
        cookie: "everything-session=workspace-image-session",
        "sec-fetch-site": "cross-site",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.get("plots/chart.png", agentId, {
        cookie: "everything-session=workspace-image-session",
        "sec-fetch-site": "same-origin",
      })
    ).status,
    200,
  );
});

test("ownership, root/teammate mismatch, traversal, encoding, hidden state and remote targets fail uniformly", async (t) => {
  const f = await fixture(t);
  const denied = [
    "../" + otherAgentId + "/plots/chart.png",
    "plots/../plots/chart.png",
    `/workspace/${otherAgentId}/plots/chart.png`,
    `/workspace/${agentId}-sibling/plots/chart.png`,
    "/etc/passwd",
    "/shared/chart.png",
    "http://localhost:1/private.png",
    "file:///etc/passwd",
    "//example.test/a.png",
    "plots\\chart.png",
    "plots/bad\0.png",
    ".pi/private.png",
    ".credentials.png",
    "%2e%2e/secret.png",
    "%252e%252e/secret.png",
    "plots/missing.png",
    "plots",
  ];
  await mkdir(path.join(f.home, ".pi"));
  await writeFile(path.join(f.home, ".pi/private.png"), png(2, 2));
  for (const file of denied) {
    const response = await f.get(file);
    assert.equal(response.status, 404, file);
    assert.deepEqual(await response.json(), {
      code: "WORKSPACE_IMAGE_UNAVAILABLE",
      message: "This image is unavailable.",
    });
  }
  for (const [id, token] of [
    [strangerAgentId, "workspace-image-token"],
    [agentId, "stranger-token"],
  ])
    assert.equal(
      (await f.get("plots/chart.png", id, { authorization: "Bearer " + token }))
        .status,
      404,
    );
  assert.equal(
    (await f.get(`/workspace/${agentId}/plots/chart.png`, otherAgentId)).status,
    404,
  );
  assert.equal((await f.get("plots/chart.png", otherAgentId)).status, 200);
  const raw = await fetch(
    `${f.origin}/v1/agents/${agentId}/workspace-image?path=%2e%2e%2f${otherAgentId}%2fplots%2fchart.png`,
    { headers: { authorization: "Bearer workspace-image-token" } },
  );
  assert.equal(raw.status, 404);
});

test("links, special files, corrupt/oversized images and deleted/replaced files are never generic downloads", async (t) => {
  const f = await fixture(t);
  const other = f.workspaces.directory(otherAgentId);
  await symlink(
    path.join(other, "plots/chart.png"),
    path.join(f.home, "link.png"),
  );
  await symlink(other, path.join(f.home, "parent-link"));
  await symlink(path.join(f.home, "plots"), path.join(f.home, "own-link"));
  await link(
    path.join(f.home, "plots/chart.png"),
    path.join(f.home, "hard.png"),
  );
  execFileSync("mkfifo", [path.join(f.home, "pipe.png")]);
  for (const [name, bytes] of [
    ["html.png", Buffer.from("<html>private text</html>")],
    ["vector.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["broken.png", png(2, 2).subarray(0, 32)],
  ] as const)
    await writeFile(path.join(f.home, name), bytes);
  const huge = png(1, 1);
  huge.writeUInt32BE(10000, 16);
  huge.writeUInt32BE(10000, 20);
  await writeFile(path.join(f.home, "pixels.png"), huge);
  const sparse = await open(path.join(f.home, "large.png"), "wx");
  await sparse.truncate(maxImageBytes + 1);
  await sparse.close();
  for (const name of [
    "link.png",
    "parent-link/plots/chart.png",
    "own-link/chart.png",
    "hard.png",
    "pipe.png",
    "html.png",
    "vector.svg",
    "broken.png",
    "pixels.png",
    "large.png",
  ])
    assert.equal((await f.get(name)).status, 404, name);
  await rm(path.join(f.home, "hard.png"));
  assert.equal((await f.get("plots/chart.png")).status, 200);
  await rm(path.join(f.home, "plots/chart.png"));
  assert.equal((await f.get("plots/chart.png")).status, 404);
  await writeFile(path.join(f.home, "plots/chart.png"), png(9, 3));
  assert.deepEqual(
    Buffer.from(await (await f.get("plots/chart.png")).arrayBuffer()),
    png(9, 3),
  );
});

test("real parent/root replacement races return only own bytes or unavailable and close descriptors", async (t) => {
  const f = await fixture(t);
  const reader = new FileSystemWorkspaceImageContent(f.workspaces);
  const own = await readFile(path.join(f.home, "plots/chart.png"));
  const original = path.join(f.home, "plots"),
    held = path.join(f.home, "held");
  for (let i = 0; i < 12; i++) {
    const pending = reader
      .read(agentId, "plots/chart.png")
      .catch(() => undefined);
    await rename(original, held);
    await symlink(
      path.join(f.workspaces.directory(otherAgentId), "plots"),
      original,
    );
    const result = await pending;
    if (result) assert.deepEqual(result.bytes, own);
    await rm(original);
    await rename(held, original);
  }
  const moved = f.home + "-held";
  const pending = reader
    .read(agentId, "plots/chart.png")
    .catch(() => undefined);
  await rename(f.home, moved);
  await symlink(f.workspaces.directory(otherAgentId), f.home);
  const result = await pending;
  if (result) assert.deepEqual(result.bytes, own);
  await rm(f.home);
  await rename(moved, f.home);
  assert.deepEqual((await reader.read(agentId, "plots/chart.png")).bytes, own);
});

test("existing files and content reads do not post; deliberate send_message persists Markdown without attachments", async (t) => {
  const f = await fixture(t);
  const url = `${f.origin}/v1/agents/${agentId}/messages`;
  const headers = {
    authorization: "Bearer workspace-image-token",
    "content-type": "application/json",
  };
  assert.deepEqual(
    ((await (await fetch(url, { headers })).json()) as { messages: unknown[] })
      .messages,
    [],
  );
  assert.equal((await f.get("plots/chart.png")).status, 200);
  assert.deepEqual(
    ((await (await fetch(url, { headers })).json()) as { messages: unknown[] })
      .messages,
    [],
  );
  const sent = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Show workspace image" }),
  });
  assert.equal(sent.status, 202);
  let messages: { role: string; text: string; attachments: unknown[] }[] = [];
  for (let i = 0; i < 100; i++) {
    messages = (
      (await (await fetch(url, { headers })).json()) as {
        messages: typeof messages;
      }
    ).messages;
    if (messages.some((message) => message.role === "assistant")) break;
    await setTimeout(10);
  }
  assert.equal(messages.length, 2);
  assert.match(messages[1]!.text, /!\[Workspace chart\]\(plots\/chart.png\)/);
  assert.deepEqual(messages[1]!.attachments, []);
  const parent: string[] = [];
  await sendMessageTool(async (text) => {
    parent.push(text);
  }, true).execute(
    "private",
    { text: "![Private](plots/chart.png)" },
    undefined,
    undefined,
    {} as never,
  );
  assert.deepEqual(parent, ["![Private](plots/chart.png)"]);
  assert.equal(
    ((await (await fetch(url, { headers })).json()) as { messages: unknown[] })
      .messages.length,
    2,
    "A fork's private callback does not append user history",
  );
});
