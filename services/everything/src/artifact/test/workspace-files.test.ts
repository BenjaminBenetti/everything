import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { artifactLimits } from "@everything/artifact-contracts";
import { checkoutFiles } from "../service/artifact-checkout.js";
import { workspaceDirectory } from "../service/workspace-path.js";
import { snapshotDirectory } from "../service/workspace-snapshot.js";

/** A temporary workspace, removed after the test. */
async function workspace(context: {
  after: (cleanup: () => Promise<void>) => void;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Write files relative to a root, creating directories as needed. */
async function write(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

test("workspace directories must stay inside the workspace, including through symbolic links", async (context) => {
  const root = await workspace(context);
  const outside = await workspace(context);
  await mkdir(path.join(root, "site"));
  await symlink(outside, path.join(root, "escape"));
  assert.equal(
    await workspaceDirectory(root, "site", { mustExist: true }),
    path.join(root, "site"),
  );
  assert.equal(
    await workspaceDirectory(root, path.join(root, "site"), {
      mustExist: true,
    }),
    path.join(root, "site"),
  );
  assert.equal(
    await workspaceDirectory(root, "new/copy", { mustExist: false }),
    path.join(root, "new/copy"),
  );
  await assert.rejects(
    workspaceDirectory(root, "../", { mustExist: false }),
    /outside your workspace/,
  );
  await assert.rejects(
    workspaceDirectory(root, "/etc", { mustExist: true }),
    /outside your workspace/,
  );
  await assert.rejects(
    workspaceDirectory(root, "escape", { mustExist: true }),
    /outside your workspace/,
  );
  await assert.rejects(
    workspaceDirectory(root, "escape/new", { mustExist: false }),
    /outside your workspace/,
  );
  await assert.rejects(
    workspaceDirectory(root, "missing", { mustExist: true }),
    /not a directory/,
  );
});

test("snapshots hash files in path order, skipping .git, private state, and symbolic links", async (context) => {
  const root = await workspace(context);
  await write(root, {
    "site/index.html": "<h1>Hi</h1>",
    "site/assets/app.js": "run()",
    "site/.git/HEAD": "ref",
    "site/.pi/session.jsonl": "private",
  });
  await chmod(path.join(root, "site/assets/app.js"), 0o755);
  await symlink(
    path.join(root, "site/index.html"),
    path.join(root, "site/link.html"),
  );
  const snapshot = await snapshotDirectory(path.join(root, "site"), {
    dockerignore: false,
    exclude: [path.join(root, "site/.pi")],
  });
  assert.deepEqual(
    snapshot.files.map((file) => [file.path, file.size, file.executable]),
    [
      ["assets/app.js", 5, true],
      ["index.html", 11, false],
    ],
  );
  assert.equal(
    snapshot.files[1]!.sha256,
    createHash("sha256").update("<h1>Hi</h1>").digest("hex"),
  );
  assert.deepEqual(snapshot.skipped, ["link.html"]);
  assert.equal(snapshot.totalSize, 16);
});

test("build sources follow .dockerignore but always include the Dockerfile", async (context) => {
  const root = await workspace(context);
  await write(root, {
    ".dockerignore": "node_modules\n*.log\n!keep.log\nDockerfile\n",
    Dockerfile: "FROM scratch",
    "node_modules/x/index.js": "x",
    "debug.log": "noise",
    "keep.log": "kept",
    "server.js": "serve()",
  });
  const snapshot = await snapshotDirectory(root, {
    dockerignore: true,
    alwaysInclude: ["Dockerfile", ".dockerignore"],
  });
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    [".dockerignore", "Dockerfile", "keep.log", "server.js"],
  );
});

test("snapshots refuse files over the size limit", async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, "huge.bin"), "");
  await truncate(path.join(root, "huge.bin"), artifactLimits.fileSize + 1);
  await assert.rejects(
    snapshotDirectory(root, { dockerignore: false }),
    /larger than/,
  );
});

test("checkouts write verified files with their modes into an empty directory", async (context) => {
  const root = await workspace(context);
  const contents: Record<string, string> = {
    "index.html": "home",
    "bin/run.sh": "#!/bin/sh",
  };
  const files = Object.entries(contents).map(([file, body]) => ({
    path: file,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.length,
    executable: file.endsWith(".sh"),
  }));
  const read = async (hash: string) =>
    Readable.from([
      Object.values(contents).find(
        (body) => createHash("sha256").update(body).digest("hex") === hash,
      )!,
    ]);
  const target = path.join(root, "copy");
  await checkoutFiles(target, files, read, false);
  assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "home");
  assert.equal(
    (await stat(path.join(target, "bin/run.sh"))).mode & 0o777,
    0o755,
  );
  await assert.rejects(checkoutFiles(target, files, read, false), /not empty/);
  await checkoutFiles(target, files, read, true);
  await assert.rejects(
    checkoutFiles(
      path.join(root, "bad"),
      files,
      async () => Readable.from(["tampered"]),
      false,
    ),
    /did not match its hash/,
  );
});

test("checkouts refuse paths and links that would write outside the target", async (context) => {
  const root = await workspace(context);
  const outside = await workspace(context);
  const body = "x";
  const entry = (file: string) => ({
    path: file,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: 1,
    executable: false,
  });
  const read = async () => Readable.from([body]);
  await assert.rejects(
    checkoutFiles(path.join(root, "a"), [entry("../escape")], read, false),
    /unsafe path/,
  );
  const target = path.join(root, "linked");
  await mkdir(target);
  await symlink(outside, path.join(target, "docs"));
  await assert.rejects(
    checkoutFiles(target, [entry("docs/x")], read, true),
    /symbolic link/,
  );
});
