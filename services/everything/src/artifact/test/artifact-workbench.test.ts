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
import { noCredentialGrants } from "../../credential/test/credential-fixture.js";
import { ArtifactRequestFailure } from "../error/artifact-errors.js";

/** A teammate whose workspace holds an app and its private conversation files, beside a shared folder. */
async function teammate(context: {
  after: (cleanup: () => Promise<void>) => void;
}): Promise<WorkbenchContext> {
  const parent = await mkdtemp(path.join(tmpdir(), "artifact-workbench-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, "agent");
  const shared = path.join(parent, "shared");
  await mkdir(shared, { recursive: true });
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
    shared,
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

test("publish, build, and checkout accept absolute paths in the workspace and the shared folder", async (context) => {
  const teammateContext = await teammate(context);
  const { workspace, shared } = teammateContext;
  const { gateway, calls } = recordingGateway([replacing("index.html")]);
  const workbench = new ArtifactWorkbench(gateway, noCredentialGrants);
  await workbench.build(teammateContext, "app", {
    context: `${workspace}/app`,
  });
  assert.deepEqual(
    calls
      .find((call) => call.method === "build")!
      .files!.map((file) => file.path),
    ["Dockerfile", "server.js"],
  );
  await workbench.publish(teammateContext, "site", {
    directory: `${workspace}/app`,
  });
  assert.deepEqual(
    calls
      .find((call) => call.method === "publish")!
      .files!.map((file) => file.path),
    ["Dockerfile", "server.js"],
  );
  const checkout = await workbench.checkout(teammateContext, "site", {
    directory: `${workspace}/copy`,
  });
  assert.equal(checkout.directory, "copy");
  assert.equal(
    await readFile(path.join(workspace, "copy/index.html"), "utf8"),
    "replaced",
  );
  const handoff = await workbench.checkout(teammateContext, "site", {
    directory: `${shared}/handoff`,
  });
  assert.equal(handoff.directory, path.join(shared, "handoff"));
  assert.equal(
    await readFile(path.join(shared, "handoff/index.html"), "utf8"),
    "replaced",
  );
});

test("publish, build, and checkout refuse the private directory before using the artifact service", async (context) => {
  const teammateContext = await teammate(context);
  const { gateway, calls } = recordingGateway([replacing("chat.jsonl")]);
  const workbench = new ArtifactWorkbench(gateway, noCredentialGrants);
  const refusals = [
    ...[".pi", `${teammateContext.workspace}/.pi`, "notes", ".pi/sessions"].map(
      (directory) => () =>
        workbench.publish(teammateContext, "site", { directory }),
    ),
    ...[".pi", "notes"].map(
      (directory) => () =>
        workbench.build(teammateContext, "app", { context: directory }),
    ),
    ...[
      ".pi/sessions",
      "notes/sessions",
      `${teammateContext.workspace}/.pi`,
    ].map(
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
  const workbench = new ArtifactWorkbench(gateway, noCredentialGrants);
  const whole = /is your whole workspace/;
  await assert.rejects(
    workbench.publish(teammateContext, "site", {
      directory: teammateContext.workspace,
    }),
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

test("file system failures name the path in the workspace that failed", async (context) => {
  const teammateContext = await teammate(context);
  const { gateway } = recordingGateway([replacing("server.js/index.html")]);
  const error = await new ArtifactWorkbench(gateway, noCredentialGrants)
    .checkout(teammateContext, "site", { directory: "app", overwrite: true })
    .then(
      () => assert.fail("expected the call to fail"),
      (failure: Error) => failure,
    );
  assert.equal(
    error.message,
    `Couldn't use "${teammateContext.workspace}/app/server.js": file already exists.`,
  );
});

test("deploying resolves named credentials among the owner's own, after reading the app's generation, and returns only names and statuses", async () => {
  const deployed: unknown[] = [];
  const events: string[] = [];
  const credentialId = "11111111-1111-4111-8111-111111111111";
  const valueId = "9c0b7a52-6d0e-4f0d-9a77-0f2a3f1f6c01";
  const refusals: Error[] = [];
  const gateway = {
    get: async () => {
      events.push("generation");
      return { credentialGeneration: 7 } as unknown as ArtifactDetails;
    },
    deploy: async (actor: unknown, reference: string, input: unknown) => {
      if (refusals.length) throw refusals.shift();
      deployed.push([actor, reference, input]);
      return {
        credentials: [
          {
            credentialId,
            name: null,
            env: "SLACK_BOT_TOKEN",
            version: 1,
            status: "pending",
          },
        ],
      } as unknown as ArtifactDetails;
    },
  } as unknown as ArtifactGateway;
  const workbench = new ArtifactWorkbench(gateway, {
    ...noCredentialGrants,
    resolve: async (ownerId, requests) => {
      events.push(`resolve:${ownerId}:${requests.map((r) => r.name)}`);
      return [
        {
          credentialId,
          env: "SLACK_BOT_TOKEN",
          version: 1,
          valueId,
          value: "wb-secret",
        },
      ];
    },
    named: async (credentials) =>
      credentials.map((credential) => ({ ...credential, name: "slack" })),
    align: async (ids) => void events.push(`align:${ids}`),
  });
  const context = {
    ownerId: "owner",
    author: { id: "agent", name: "Ada" },
    workspace: "/workspace/agent",
    shared: "/workspace/shared",
    privateDirectory: "/workspace/agent/.pi",
  };
  const result = await workbench.deploy(context, "bot", {
    build: 2,
    credentials: [{ name: "slack", env: "SLACK_BOT_TOKEN" }],
  });
  // The generation is read before the grant is authorized, so a removal in between refuses it.
  assert.deepEqual(events, ["generation", "resolve:owner:slack"]);
  assert.deepEqual(deployed, [
    [
      { ownerId: "owner", author: { id: "agent", name: "Ada" } },
      "bot",
      {
        build: 2,
        credentials: [
          {
            credentialId,
            env: "SLACK_BOT_TOKEN",
            version: 1,
            valueId,
            value: "wb-secret",
          },
        ],
        credentialGeneration: 7,
      },
    ],
  ]);
  assert.equal(result.credentials[0]?.name, "slack");
  assert.ok(!JSON.stringify(result).includes("wb-secret"));

  // Omitted credentials and an explicit [] need neither resolution nor a generation.
  events.length = 0;
  await workbench.deploy(context, "bot", { build: 2 });
  await workbench.deploy(context, "bot", { build: 2, credentials: [] });
  assert.deepEqual(events, []);
  assert.deepEqual(
    deployed.slice(1).map((call) => (call as unknown[])[2]),
    [{ build: 2 }, { build: 2, credentials: [] }],
  );

  // Another value at the same version is aligned once and retried; a stale generation is not.
  refusals.push(
    new ArtifactRequestFailure(409, "CREDENTIAL_VALUE_CONFLICT", "Conflict."),
  );
  await workbench.deploy(context, "bot", {
    credentials: [{ name: "slack", env: "SLACK_BOT_TOKEN" }],
  });
  assert.deepEqual(events, [
    "generation",
    "resolve:owner:slack",
    `align:${credentialId}`,
    "generation",
    "resolve:owner:slack",
  ]);
  refusals.push(
    new ArtifactRequestFailure(409, "CREDENTIAL_GRANTS_CHANGED", "Changed."),
  );
  await assert.rejects(
    workbench.deploy(context, "bot", {
      credentials: [{ name: "slack", env: "SLACK_BOT_TOKEN" }],
    }),
    { code: "CREDENTIAL_GRANTS_CHANGED" },
  );
});
