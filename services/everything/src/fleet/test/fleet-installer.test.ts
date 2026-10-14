import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { FleetInstaller } from "../service/fleet-installer.js";

/** Fake release files: each one's content is its own name. */
const assets = [
  "fleet-linux-amd64",
  "fleet-linux-arm64",
  "fleet-pod-linux-amd64",
  "fleet-pod-linux-arm64",
  "fleet-tmux-linux-amd64.tar.gz",
  "fleet-tmux-linux-arm64.tar.gz",
];

/** SHA-256 of a string in hex. */
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** An empty binary directory, a release pinning every fake file, and a recording download. */
async function fixture(
  context: TestContext,
  served = (asset: string) => asset,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-install-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const requested: string[] = [];
  const release = {
    version: "v3.0.0-beta",
    url: "https://releases.test/fleet",
    checksums: Object.fromEntries(
      assets.map((asset) => [asset, sha256(asset)]),
    ),
  };
  /** Serve each file at its release URL. */
  const download = async (url: string) => {
    requested.push(url);
    const asset = url.split("/").at(-1)!;
    return new Response(served(asset));
  };
  return {
    directory,
    requested,
    release,
    installer: new FleetInstaller(release, directory, "amd64", download),
  };
}

test("installs fleetd for its architecture and the pod files for every node architecture", async (context) => {
  const { directory, requested, installer } = await fixture(context);
  await installer.install();
  assert.deepEqual((await readdir(directory)).sort(), [
    "fleet",
    "fleet-pod-linux-amd64",
    "fleet-pod-linux-arm64",
    "fleet-tmux-linux-amd64.tar.gz",
    "fleet-tmux-linux-arm64.tar.gz",
  ]);
  assert.equal(
    await readFile(path.join(directory, "fleet"), "utf8"),
    "fleet-linux-amd64",
  );
  assert.ok(
    requested.includes(
      "https://releases.test/fleet/v3.0.0-beta/fleet-linux-amd64",
    ),
  );
});

test("downloads only files that are missing or differ from their pin", async (context) => {
  const { directory, requested, installer } = await fixture(context);
  await installer.install();
  await writeFile(path.join(directory, "fleet-pod-linux-arm64"), "tampered");
  requested.length = 0;
  await installer.install();
  assert.deepEqual(requested, [
    "https://releases.test/fleet/v3.0.0-beta/fleet-pod-linux-arm64",
  ]);
  assert.equal(
    await readFile(path.join(directory, "fleet-pod-linux-arm64"), "utf8"),
    "fleet-pod-linux-arm64",
  );
});

test("never installs or retries a file whose checksum differs from the pin", async (context) => {
  const { directory, requested, installer } = await fixture(context, (asset) =>
    asset === "fleet-linux-amd64" ? "replaced" : asset,
  );
  await assert.rejects(installer.install(), /not the pinned/);
  assert.equal(requested.length, 1);
  assert.deepEqual(await readdir(directory), []);
});

test("refuses a release file the chart pins no checksum for", async (context) => {
  const { directory, release } = await fixture(context);
  const { "fleet-linux-arm64": _omitted, ...checksums } = release.checksums;
  const installer = new FleetInstaller(
    { ...release, checksums },
    directory,
    "arm64",
    async () => new Response("unused"),
  );
  await assert.rejects(
    installer.install(),
    /pins no checksum for fleet-linux-arm64/,
  );
});
