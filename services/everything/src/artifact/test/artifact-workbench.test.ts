import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type {
  ArtifactBuild,
  ArtifactDetails,
  ArtifactFile,
  ArtifactSource,
} from "@everything/artifact-contracts";
import type { ArtifactGateway } from "../interface/artifact-gateway.js";
import {
  ArtifactWorkbench,
  type WorkbenchContext,
} from "../service/artifact-workbench.js";

/** A teammate whose workspace holds an app and its private conversation files. */
async function teammate(context: {
  after: (cleanup: () => Promise<void>) => void;
}): Promise<WorkbenchContext> {
  const workspace = await mkdtemp(path.join(tmpdir(), "artifact-workbench-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({
    "app/Dockerfile": "FROM scratch",
    "app/server.js": "serve()",
    ".pi/sessions/chat.jsonl": "private",
  })) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), content);
  }
  await symlink(path.join(workspace, ".pi"), path.join(workspace, "notes"));
  return {
    ownerId: "owner",
    author: { id: "agent", name: "Ada" },
    workspace,
    privateDirectory: path.join(workspace, ".pi"),
  };
}

/** A gateway that records uploads and releases, serving `source` for checkouts. */
function recordingGateway(source: readonly ArtifactFile[] = []) {
  const calls: { method: string; files?: readonly ArtifactFile[] }[] = [];
  const bodies = new Map<string, string>();
  const gateway = {
    missingContent: async (hashes: readonly string[]) => [...new Set(hashes)],
    uploadContent: async (hash: string, content: Blob) => {
      bodies.set(hash, await content.text());
      calls.push({ method: "uploadContent" });
    },
    publish: async (
      _actor: unknown,
      _reference: string,
      input: { files: readonly ArtifactFile[] },
    ) => {
      calls.push({ method: "publish", files: input.files });
      return { release: 1 } as ArtifactDetails;
    },
    build: async (
      _actor: unknown,
      _reference: string,
      input: { files: readonly ArtifactFile[] },
    ) => {
      calls.push({ method: "build", files: input.files });
      return { number: 1 } as ArtifactBuild;
    },
    source: async () => {
      calls.push({ method: "source" });
      return {
        origin: "revision",
        number: 1,
        release: 1,
        files: source,
      } as unknown as ArtifactSource;
    },
    readContent: async () => Readable.from(["replaced"]),
  } as unknown as ArtifactGateway;
  return { gateway, calls, bodies };
}

/** A source file entry whose content is "replaced". */
function replacing(file: string): ArtifactFile {
  return {
    path: file,
    sha256: createHash("sha256").update("replaced").digest("hex"),
    size: 8,
    executable: false,
  };
}

test("publish, build, and checkout accept /workspace paths and report paths as the teammate sees them", async (context) => {
  const teammateContext = await teammate(context);
  const { gateway, calls } = recordingGateway([replacing("index.html")]);
  const workbench = new ArtifactWorkbench(gateway);
  await workbench.build(teammateContext, "app", { context: "/workspace/app" });
  assert.deepEqual(
    calls
      .find((call) => call.method === "build")!
      .files!.map((file) => file.path),
    ["Dockerfile", "server.js"],
  );
  await workbench.publish(teammateContext, "site", {
    directory: "/workspace/app",
  });
  assert.deepEqual(
    calls
      .find((call) => call.method === "publish")!
      .files!.map((file) => file.path),
    ["Dockerfile", "server.js"],
  );
  const checkout = await workbench.checkout(teammateContext, "site", {
    directory: "/workspace/copy",
  });
  assert.equal(checkout.directory, "copy");
  assert.equal(
    await readFile(
      path.join(teammateContext.workspace, "copy/index.html"),
      "utf8",
    ),
    "replaced",
  );
});

test("publish, build, and checkout refuse the private directory before using the artifact service", async (context) => {
  const teammateContext = await teammate(context);
  const { gateway, calls } = recordingGateway([replacing("chat.jsonl")]);
  const workbench = new ArtifactWorkbench(gateway);
  const refusals = [
    ...[".pi", "/workspace/.pi", "notes", ".pi/sessions"].map(
      (directory) => () =>
        workbench.publish(teammateContext, "site", { directory }),
    ),
    ...[".pi", "notes"].map(
      (directory) => () =>
        workbench.build(teammateContext, "app", { context: directory }),
    ),
    ...[".pi/sessions", "notes/sessions", "/workspace/.pi"].map(
      (directory) => () =>
        workbench.checkout(teammateContext, "site", {
          directory,
          overwrite: true,
        }),
    ),
  ];
  for (const refusal of refusals) {
    const error = await refusal().then(
      () => assert.fail("expected the call to fail"),
      (failure: Error) => failure,
    );
    assert.match(error.message, /Private conversation files are unavailable\./);
    assert.ok(
      !error.message.includes(teammateContext.workspace),
      error.message,
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(
    await readFile(
      path.join(teammateContext.privateDirectory, "sessions/chat.jsonl"),
      "utf8",
    ),
    "private",
  );
});

test("the workspace root is refused for every upload and checkout, before the artifact service is called", async (context) => {
  const teammateContext = await teammate(context);
  const { gateway, calls } = recordingGateway([
    replacing("app/server.js"),
    replacing(".pi/sessions/chat.jsonl"),
  ]);
  const workbench = new ArtifactWorkbench(gateway);
  const whole = /is your whole workspace/;
  await assert.rejects(
    workbench.publish(teammateContext, "site", { directory: "/workspace" }),
    whole,
  );
  await assert.rejects(
    workbench.build(teammateContext, "app", { context: "." }),
    whole,
  );
  await assert.rejects(
    workbench.checkout(teammateContext, "site", {
      directory: ".",
      overwrite: true,
    }),
    whole,
  );
  assert.deepEqual(calls, []);
  const read = (file: string) =>
    readFile(path.join(teammateContext.workspace, file), "utf8");
  assert.equal(await read("app/server.js"), "serve()");
  assert.equal(await read(".pi/sessions/chat.jsonl"), "private");
});

test("file system failures name paths under /workspace, never where the workspace lives", async (context) => {
  const teammateContext = await teammate(context);
  const { gateway } = recordingGateway([replacing("server.js/index.html")]);
  const error = await new ArtifactWorkbench(gateway)
    .checkout(teammateContext, "site", { directory: "app", overwrite: true })
    .then(
      () => assert.fail("expected the call to fail"),
      (failure: Error) => failure,
    );
  assert.equal(
    error.message,
    'Couldn\'t use "/workspace/app/server.js": file already exists.',
  );
});
