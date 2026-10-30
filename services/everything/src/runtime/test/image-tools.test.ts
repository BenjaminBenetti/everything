import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  agentId,
  otherAgentId,
  png,
  pngBytes,
  workspaceVolume,
} from "../../attachment/test/attachment-fixtures.js";
import { FileSystemWorkspaceImages } from "../../workspace/adapter/file-system-workspace-images.js";
import type { WorkspaceImages } from "../../workspace/interface/workspace-images.js";
import { imageTools } from "../tool/image-tools.js";

const vision = { input: ["text", "image"] };
const textOnly = { input: ["text"] };

/** Call image_view as Pi does, with the session's current model in the tool context. */
async function view(
  images: WorkspaceImages,
  file: string,
  model: object | undefined,
) {
  const [tool] = imageTools(images, agentId);
  return tool!.execute("call", { path: file }, undefined, undefined, {
    model,
  } as never);
}

/** A temporary volume with images in the teammate's workspace, another teammate's, and the shared folder. */
async function fixture(context: TestContext) {
  const volume = await workspaceVolume(context);
  const home = volume.workspace(agentId);
  const other = volume.workspace(otherAgentId);
  await mkdir(path.join(home, "attachments", "a"), { recursive: true });
  await mkdir(path.join(home, ".pi"), { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(path.join(home, "attachments", "a", "photo.png"), pngBytes);
  await writeFile(path.join(home, ".pi", "private.png"), pngBytes);
  await writeFile(path.join(other, "secret.png"), pngBytes);
  await writeFile(path.join(volume.workspaces.shared, "team.png"), pngBytes);
  await writeFile(path.join(home, "notes.txt"), "not an image");
  return {
    volume,
    home,
    other,
    images: new FileSystemWorkspaceImages(volume.workspaces),
  };
}

test("a vision model sees the image only when it asks, scaled to the model's limits", async (context) => {
  const { images, home } = await fixture(context);
  const result = await view(images, "attachments/a/photo.png", vision);
  assert.equal(result.content.length, 2);
  const [note, image] = result.content;
  assert.equal(note!.type, "text");
  assert.match((note as { text: string }).text, /image\/png, 2×1/);
  assert.equal(image!.type, "image");
  assert.ok(Buffer.from((image as { data: string }).data, "base64").length > 0);
  await writeFile(path.join(home, "wide.png"), png(3000, 20));
  const wide = await view(images, `${home}/wide.png`, vision);
  assert.match(
    (wide.content[0] as { text: string }).text,
    /3000×20, shown scaled to 2000×\d+/,
  );
});

test("a model without vision receives no pixels and an honest explanation", async () => {
  let reads = 0;
  const images: WorkspaceImages = {
    async read() {
      reads++;
      throw new Error("must not read");
    },
  };
  for (const model of [textOnly, undefined]) {
    const result = await view(images, "photo.png", model);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
    assert.match(
      (result.content[0] as { text: string }).text,
      /can't view images, so the image wasn't loaded/,
    );
  }
  assert.equal(reads, 0);
});

test("images are confined to what the teammate's own pod can open", async (context) => {
  const { images, volume, home, other } = await fixture(context);
  const shared = await view(
    images,
    path.join(volume.workspaces.shared, "team.png"),
    vision,
  );
  assert.equal(shared.content[1]!.type, "image");
  await symlink(path.join(other, "secret.png"), path.join(home, "linked.png"));
  await symlink(other, path.join(home, "linked-folder"));
  // Links to folders the pod can reach work; a link as the file itself is refused, as file_read refuses it.
  await symlink(volume.workspaces.shared, path.join(home, "team-folder"));
  assert.equal(
    (await view(images, "team-folder/team.png", vision)).content[1]!.type,
    "image",
  );
  await symlink(
    path.join(volume.workspaces.shared, "team.png"),
    path.join(home, "shared-link.png"),
  );
  for (const [file, message] of [
    ["../" + otherAgentId + "/secret.png", /outside your workspace/],
    [path.join(other, "secret.png"), /outside your workspace/],
    [".pi/private.png", /outside your workspace/],
    ["linked.png", /couldn't be opened/],
    ["shared-link.png", /couldn't be opened/],
    ["linked-folder/secret.png", /leads outside/],
    ["notes.txt", /isn't a PNG, JPEG, GIF, or WebP image/],
    ["missing.png", /couldn't be opened/],
    ["attachments", /not a regular file/],
    ["bad\u0000.png", /outside your workspace/],
  ] as const)
    await assert.rejects(view(images, file, vision), message, file);
});

test("pictures too large to decode safely are refused before decoding", async (context) => {
  const { images, home } = await fixture(context);
  // A header claiming 10000×10000 pixels; its pixel data is never read.
  const header = png(1, 1);
  header.writeUInt32BE(10_000, 16);
  header.writeUInt32BE(10_000, 20);
  await writeFile(path.join(home, "huge.png"), header);
  await assert.rejects(
    view(images, "huge.png", vision),
    /10000×10000 pixels, too large/,
  );
});
