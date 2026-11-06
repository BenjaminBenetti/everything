import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { ArtifactFile } from "@everything/artifact-contracts";
import { HttpArtifactGateway } from "../adapter/http-artifact-gateway.js";
import {
  ArtifactWorkbench,
  type WorkbenchContext,
} from "../service/artifact-workbench.js";
import { noCredentialGrants } from "../../credential/test/credential-fixture.js";
import { sparse, sparseHash } from "./sparse-files.js";

const MiB = 1024 * 1024;

/** Content a sparse file holds: its size and the prefix before its zeros. */
interface SparseContent {
  readonly size: number;
  readonly prefix: string;
}

/** What the stand-in artifact service received. */
interface Received {
  /** Every request, as method and path. */
  readonly requests: string[];
  /** Each upload's address, the bytes that arrived, their declared length, and their hash. */
  readonly uploads: {
    hash: string;
    bytes: number;
    contentLength: number;
    sha256: string;
  }[];
  /** File lists of revisions and builds, by path suffix. */
  readonly releases: { kind: string; files: ArtifactFile[] }[];
  /** Most uploads in progress at once. */
  peakUploads: number;
}

/** Bytes of sparse content, streamed from one reused zero chunk. */
function* sparseBytes({ size, prefix }: SparseContent): Generator<Buffer> {
  yield Buffer.from(prefix);
  const zeros = Buffer.alloc(MiB);
  for (let left = size - Buffer.byteLength(prefix); left > 0; left -= MiB)
    yield left < MiB ? zeros.subarray(0, left) : zeros;
}

/** Answer with JSON. */
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * A stand-in for the artifact service's internal API over real HTTP. It counts and hashes every
 * uploaded byte without keeping it, and serves checkouts of the published files it can regenerate.
 */
async function artifactService(
  context: { after: (cleanup: () => Promise<void>) => void },
  regenerated: ReadonlyMap<string, SparseContent>,
) {
  const stored = new Set<string>();
  const received: Received = {
    requests: [],
    uploads: [],
    releases: [],
    peakUploads: 0,
  };
  let active = 0;
  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    received.requests.push(`${request.method} ${url}`);
    const content = /^\/internal\/v1\/content\/([0-9a-f]{64})$/.exec(url)?.[1];
    if (request.method === "PUT" && content) {
      active += 1;
      received.peakUploads = Math.max(received.peakUploads, active);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of request as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      active -= 1;
      const sha256 = hash.digest("hex");
      received.uploads.push({
        hash: content,
        bytes,
        contentLength: Number(request.headers["content-length"]),
        sha256,
      });
      if (sha256 === content) stored.add(sha256);
      return void response.writeHead(204).end();
    }
    if (request.method === "GET" && content) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      return void Readable.from(sparseBytes(regenerated.get(content)!)).pipe(
        response,
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>)
      chunks.push(chunk);
    const body = (
      chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    ) as { hashes?: string[]; files?: ArtifactFile[] };
    if (url === "/internal/v1/content/missing")
      return send(response, 200, {
        missing: [...new Set(body.hashes)].filter((hash) => !stored.has(hash)),
      });
    const release = /\/artifacts\/[a-z]+\/(revisions|builds)$/.exec(url)?.[1];
    if (release) {
      received.releases.push({ kind: release, files: body.files ?? [] });
      return send(response, 201, { number: 1, release: 1 });
    }
    if (url.endsWith("/artifacts/site/source"))
      return send(response, 200, {
        origin: "revision",
        number: 1,
        release: 1,
        files: received.releases[0]!.files.slice(0, 1),
      });
    send(response, 404, { code: "NOT_FOUND", message: "Not found." });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  context.after(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
  };
}

test("a 1 GiB app directory of 100 MiB files is published, built, and checked out over HTTP, file by file, in bounded memory", async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), "app-upload-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, "agent");
  const teammate: WorkbenchContext = {
    ownerId: "owner",
    author: { id: "agent", name: "Ada" },
    workspace,
    shared: path.join(parent, "shared"),
    privateDirectory: path.join(workspace, ".pi"),
  };
  await mkdir(teammate.shared, { recursive: true });

  // Ten 100 MiB files, the last sharing the first's content, and 24 MiB more: exactly 1 GiB.
  const app = path.join(workspace, "app");
  await mkdir(app, { recursive: true });
  const contents = new Map<string, SparseContent>();
  for (let index = 0; index < 10; index++) {
    const content = { size: 100 * MiB, prefix: String(index % 9) };
    await sparse(
      path.join(app, `part-${index}.bin`),
      content.size,
      content.prefix,
    );
    contents.set(sparseHash(content.size, content.prefix), content);
  }
  const rest = { size: 24 * MiB, prefix: "r" };
  await sparse(path.join(app, "rest.bin"), rest.size, rest.prefix);
  contents.set(sparseHash(rest.size, rest.prefix), rest);

  const service = await artifactService(context, contents);
  const workbench = new ArtifactWorkbench(
    new HttpArtifactGateway(
      {
        url: service.url,
        hostUrl: "http://artifact.test",
        publicAppsHostUrl: "http://public-apps.test",
      },
      { token: async () => "service-token" },
    ),
    noCredentialGrants,
  );
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  try {
    await workbench.publish(teammate, "site", { directory: "app" });
  } finally {
    clearInterval(sampler);
  }
  context.diagnostic(
    `Memory grew by ${Math.round((peak - before) / MiB)} MiB while publishing 1 GiB`,
  );
  assert.ok(
    peak - before < 256 * MiB,
    `Memory grew by ${Math.round((peak - before) / MiB)} MiB while publishing 1 GiB`,
  );

  // Each distinct content was uploaded once, whole, under its own hash, at most four at a time.
  assert.equal(service.received.uploads.length, 10);
  for (const upload of service.received.uploads) {
    const content = contents.get(upload.hash)!;
    assert.deepEqual(
      [upload.bytes, upload.contentLength, upload.sha256],
      [content.size, content.size, upload.hash],
    );
  }
  assert.equal(
    service.received.uploads.reduce((total, upload) => total + upload.bytes, 0),
    924 * MiB,
  );
  assert.ok(service.received.peakUploads <= 4);
  // The revision lists every path at its full size, so shared content counts at both paths.
  const revision = service.received.releases[0]!;
  assert.equal(revision.kind, "revisions");
  assert.deepEqual(
    [revision.files.length, revision.files.reduce((sum, f) => sum + f.size, 0)],
    [11, 1_073_741_824],
  );

  // One byte more is refused before anything reaches the artifact service.
  const requests = service.received.requests.length;
  await writeFile(path.join(app, "a.txt"), "x");
  await assert.rejects(
    workbench.publish(teammate, "site", { directory: "app" }),
    { name: "SnapshotLimitError", message: "The files total more than 1 GiB." },
  );
  assert.equal(service.received.requests.length, requests);

  // A build counts only what .dockerignore keeps, and uploads only content the service lacks.
  const api = path.join(workspace, "api");
  await mkdir(path.join(api, "cache"), { recursive: true });
  await writeFile(path.join(api, "Dockerfile"), "FROM scratch\nCOPY . /\n");
  await writeFile(path.join(api, ".dockerignore"), "cache\n");
  await sparse(path.join(api, "model.bin"), 100 * MiB, "1");
  await sparse(path.join(api, "cache/layers.tar"), 2048 * MiB);
  await workbench.build(teammate, "api", { context: "api" });
  const build = service.received.releases[1]!;
  assert.deepEqual(
    [build.kind, build.files.map((file) => [file.path, file.size])],
    [
      "builds",
      [
        [".dockerignore", 6],
        ["Dockerfile", 22],
        ["model.bin", 100 * MiB],
      ],
    ],
  );
  assert.deepEqual(
    service.received.uploads
      .slice(10)
      .map((upload) => upload.bytes)
      .sort((a, b) => a - b),
    [6, 22],
  );

  // Checking out streams a 100 MiB file back and verifies it against its hash.
  await workbench.checkout(teammate, "site", { directory: "copy" });
  assert.equal(
    (await stat(path.join(workspace, "copy/part-0.bin"))).size,
    100 * MiB,
  );
});
