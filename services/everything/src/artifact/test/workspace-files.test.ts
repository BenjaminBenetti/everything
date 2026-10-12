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
import { inWorkspace, workspaceDirectory } from "../service/workspace-path.js";
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

/** The workspace as the artifact tools see it, with its private directory. */
function location(root: string) {
  return { workspace: root, privateDirectory: path.join(root, ".pi") };
}

/** A source file entry for content, as the artifact service lists it. */
function sourceFile(file: string, body: string) {
  return {
    path: file,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.length,
    executable: false,
  };
}

/** The message of a rejected promise. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("expected the call to fail");
}

test("workspace directories must stay inside the workspace, including through symbolic links", async (context) => {
  const root = await workspace(context);
  const outside = await workspace(context);
  await mkdir(path.join(root, "site"));
  await writeFile(path.join(root, "notes.txt"), "notes");
  await symlink(outside, path.join(root, "escape"));
  const at = location(root);
  assert.equal(
    await workspaceDirectory(at, "site", { mustExist: true }),
    path.join(root, "site"),
  );
  assert.equal(
    await workspaceDirectory(at, "new/copy", { mustExist: false }),
    path.join(root, "new/copy"),
  );
  await assert.rejects(
    workspaceDirectory(at, "../", { mustExist: false }),
    /outside your workspace/,
  );
  await assert.rejects(
    workspaceDirectory(at, "/etc", { mustExist: true }),
    /outside your workspace/,
  );
  await assert.rejects(
    workspaceDirectory(at, "escape", { mustExist: true }),
    /outside your workspace/,
  );
  await assert.rejects(
    workspaceDirectory(at, "escape/new", { mustExist: false }),
    /outside your workspace/,
  );
  await assert.rejects(
    workspaceDirectory(at, "missing", { mustExist: true }),
    /not a directory/,
  );
  await assert.rejects(
    workspaceDirectory(at, "notes.txt", { mustExist: false }),
    /not a directory/,
  );
});

test("absolute paths name the workspace as the teammate's pod mounts it", async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, "app"));
  const at = location(root);
  for (const [directory, expected] of [
    ["/workspace/app", path.join(root, "app")],
    ["/workspace/app/../app/", path.join(root, "app")],
  ] as const)
    assert.equal(
      await workspaceDirectory(at, directory, { mustExist: true }),
      expected,
      directory,
    );
  assert.equal(
    await workspaceDirectory(at, "/workspace/new/copy", { mustExist: false }),
    path.join(root, "new/copy"),
  );
  // The workspace's location in this process means nothing to the teammate.
  for (const directory of [
    path.join(root, "app"),
    "/workspace/../etc",
    "/workspaces/app",
    "/workspace\0/app",
  ]) {
    const message = await failure(
      workspaceDirectory(at, directory, { mustExist: false }),
    );
    assert.match(message, /outside your workspace/, directory);
    assert.match(message, /under \/workspace\./, directory);
  }
});

test("the workspace itself is refused, since it also holds the teammate's tools and settings", async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, "app"));
  await symlink(root, path.join(root, "home"));
  const at = location(root);
  for (const directory of [
    ".",
    "./",
    "app/..",
    "/workspace",
    "/workspace/",
    "home",
  ])
    await assert.rejects(
      workspaceDirectory(at, directory, { mustExist: false }),
      /is your whole workspace, which also holds your installed tools and settings\. Use a directory inside it/,
      directory,
    );
  assert.equal(
    await workspaceDirectory(at, "app", { mustExist: true }),
    path.join(root, "app"),
  );
});

test("refusals and file system failures never reveal where the workspace lives", async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, ".pi"));
  await writeFile(path.join(root, "notes.txt"), "notes");
  const at = location(root);
  const gone = location(path.join(root, "gone"));
  const messages = [
    await failure(workspaceDirectory(at, "../x", { mustExist: false })),
    await failure(workspaceDirectory(at, "missing", { mustExist: true })),
    await failure(workspaceDirectory(at, ".pi", { mustExist: true })),
    await failure(inWorkspace(at, () => mkdir(path.join(root, "notes.txt/x")))),
    await failure(
      inWorkspace(gone, () =>
        workspaceDirectory(gone, ".", { mustExist: true }),
      ),
    ),
  ];
  for (const message of messages) {
    assert.ok(!message.includes(root), message);
    assert.doesNotMatch(message, /\/agents|\/tmp/);
  }
  assert.equal(
    messages[3],
    'Couldn\'t use "/workspace/notes.txt/x": not a directory.',
  );
  assert.equal(
    messages[4],
    'Couldn\'t use "/workspace": no such file or directory.',
  );
  const unrelated = new Error("plain failure");
  await assert.rejects(
    inWorkspace(at, async () => {
      throw unrelated;
    }),
    (error) => error === unrelated,
  );
});

test("the private directory is refused by name, by absolute path, and through symbolic links", async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, ".pi/sessions"), { recursive: true });
  await mkdir(path.join(root, "site"));
  await symlink(path.join(root, ".pi"), path.join(root, "notes"));
  await symlink(".pi/sessions", path.join(root, "history"));
  await symlink(root, path.join(root, "site/home"));
  const at = location(root);
  for (const [directory, mustExist] of [
    [".pi", true],
    [".pi/", true],
    [".pi/sessions", true],
    [".pi/new", false],
    ["site/../.pi", true],
    ["/workspace/.pi", true],
    ["/workspace/.pi/sessions", false],
    ["notes", true],
    ["notes/sessions", true],
    ["notes/new", false],
    ["history", true],
    ["site/home/.pi", true],
  ] as const)
    await assert.rejects(
      workspaceDirectory(at, directory, { mustExist }),
      new RegExp(
        `^WorkspacePathError: "${directory.replaceAll(".", "\\.")}" can't be used\\. Private conversation files are unavailable\\.$`,
      ),
      directory,
    );
  assert.equal(
    await workspaceDirectory(at, ".pi-notes", { mustExist: false }),
    path.join(root, ".pi-notes"),
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

test("snapshots never include the private directory, whatever root they start from", async (context) => {
  const root = await workspace(context);
  await write(root, {
    "index.html": "home",
    ".pi/sessions/chat.jsonl": "private",
    ".pi/settings.json": "{}",
  });
  await symlink(path.join(root, ".pi"), path.join(root, "notes"));
  await symlink(root, path.join(root, "home"));
  const exclude = [path.join(root, ".pi")];
  const paths = async (start: string) =>
    (
      await snapshotDirectory(path.join(root, start), {
        dockerignore: false,
        exclude,
      })
    ).files.map((file) => file.path);
  assert.deepEqual(await paths("."), ["index.html"]);
  assert.deepEqual(await paths("home"), ["index.html"]);
  for (const start of [".pi", ".pi/sessions", "notes", "home/.pi"])
    assert.deepEqual(await paths(start), [], start);
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
  await checkoutFiles(target, files, read, { overwrite: false });
  assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "home");
  assert.equal(
    (await stat(path.join(target, "bin/run.sh"))).mode & 0o777,
    0o755,
  );
  await assert.rejects(
    checkoutFiles(target, files, read, { overwrite: false }),
    /not empty/,
  );
  await checkoutFiles(target, files, read, { overwrite: true });
  await assert.rejects(
    checkoutFiles(
      path.join(root, "bad"),
      files,
      async () => Readable.from(["tampered"]),
      { overwrite: false },
    ),
    /did not match its hash/,
  );
});

test("checkouts refuse paths and links that would write outside the target", async (context) => {
  const root = await workspace(context);
  const outside = await workspace(context);
  const entry = (file: string) => sourceFile(file, "x");
  const read = async () => Readable.from(["x"]);
  await assert.rejects(
    checkoutFiles(path.join(root, "a"), [entry("../escape")], read, {
      overwrite: false,
    }),
    /unsafe path/,
  );
  const target = path.join(root, "linked");
  await mkdir(target);
  await symlink(outside, path.join(target, "docs"));
  await assert.rejects(
    checkoutFiles(target, [entry("first"), entry("docs/x")], read, {
      overwrite: true,
    }),
    /symbolic link/,
  );
  await assert.rejects(stat(path.join(target, "first")), { code: "ENOENT" });
});

test("checkouts never write into the private directory, and write nothing when a file would", async (context) => {
  const root = await workspace(context);
  await write(root, {
    "index.html": "old",
    ".pi/sessions/chat.jsonl": "private",
  });
  await symlink(path.join(root, ".pi"), path.join(root, "notes"));
  const privateDirectory = path.join(root, ".pi");
  const contents: Record<string, string> = {
    "index.html": "new",
    ".pi/sessions/chat.jsonl": "replaced",
    "sessions/chat.jsonl": "replaced",
    "notes/sessions/chat.jsonl": "replaced",
  };
  const read = async (hash: string) =>
    Readable.from([
      Object.values(contents).find(
        (body) => createHash("sha256").update(body).digest("hex") === hash,
      )!,
    ]);
  const files = (...names: string[]) =>
    names.map((name) => sourceFile(name, contents[name]!));
  const options = { overwrite: true, privateDirectory };
  await assert.rejects(
    checkoutFiles(
      root,
      files("index.html", ".pi/sessions/chat.jsonl"),
      read,
      options,
    ),
    /^WorkspacePathError: "\.pi\/sessions\/chat\.jsonl" can't be used\. Private conversation files are unavailable\.$/,
  );
  await assert.rejects(
    checkoutFiles(
      root,
      files("index.html", "notes/sessions/chat.jsonl"),
      read,
      options,
    ),
    /Private conversation files are unavailable/,
  );
  for (const target of [".pi", ".pi/sessions", "notes"])
    await assert.rejects(
      checkoutFiles(
        path.join(root, target),
        files("sessions/chat.jsonl"),
        read,
        options,
      ),
      /Private conversation files are unavailable/,
      target,
    );
  assert.equal(await readFile(path.join(root, "index.html"), "utf8"), "old");
  assert.equal(
    await readFile(path.join(root, ".pi/sessions/chat.jsonl"), "utf8"),
    "private",
  );
  await checkoutFiles(root, files("index.html"), read, options);
  assert.equal(await readFile(path.join(root, "index.html"), "utf8"), "new");
});
