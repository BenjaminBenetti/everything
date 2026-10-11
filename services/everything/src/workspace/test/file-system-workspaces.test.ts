import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileSystemWorkspaces } from "../service/file-system-workspaces.js";

/** A temporary root with one other agent's directory that must survive. */
async function fixture(context: { after(callback: () => unknown): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "everything-workspaces-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "other-agent"));
  return { root, workspaces: new FileSystemWorkspaces(root) };
}

test("removes only the deleted agent's directory and its contents", async (context) => {
  const { root, workspaces } = await fixture(context);
  const directory = workspaces.directory("agent-id");
  assert.equal(directory, path.join(root, "agent-id"));
  await mkdir(path.join(directory, ".pi", "sessions"), { recursive: true });
  await writeFile(path.join(directory, "notes.md"), "remember this");
  await workspaces.remove("agent-id");
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(path.join(root, "other-agent")), true);
  await workspaces.remove("agent-id");
});

test("refuses IDs that would resolve outside a single agent directory", async (context) => {
  const { root, workspaces } = await fixture(context);
  for (const id of ["", ".", "..", "../outside", "nested/agent", root])
    await assert.rejects(workspaces.remove(id), /inside the root/);
  assert.equal(existsSync(path.join(root, "other-agent")), true);
});
