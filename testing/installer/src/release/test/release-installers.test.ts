import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { parse } from "yaml";
import {
  FakeHost,
  executable,
  scriptDirectory,
  sha256,
} from "../../local/fixture/fake-host.js";

const workflowFile = resolve(
  scriptDirectory,
  "../../.github/workflows/release.yaml",
);

interface WorkflowStep {
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}

/** The release job's steps, from the workflow GitHub runs. */
function releaseSteps(): WorkflowStep[] {
  const workflow = parse(readFileSync(workflowFile, "utf8")) as {
    jobs: { release: { steps: WorkflowStep[] } };
  };
  return workflow.jobs.release.steps;
}

function step(name: string): WorkflowStep {
  const found = releaseSteps().find((candidate) => candidate.name === name);
  assert.ok(found, `the release job has no step named ${name}`);
  return found;
}

/** Run a step's script as GitHub's `shell: bash` does, from the repository's root. */
function runStep(script: string, env: Record<string, string>): string {
  return execFileSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
    {
      cwd: resolve(scriptDirectory, "../.."),
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    },
  );
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "everything-release-test-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("release-installers.sh", () => {
  test("pins both installers to the release, and the local one to the regular one's digest", () => {
    execFileSync("bash", [
      join(scriptDirectory, "release-installers.sh"),
      "1.2.3-rc.1",
      directory,
    ]);
    const installer = readFileSync(join(directory, "install.sh"), "utf8");
    const local = readFileSync(join(directory, "install-k3s.sh"), "utf8");
    assert.match(installer, /^release_version="1\.2\.3-rc\.1"$/m);
    assert.match(local, /^release_version="1\.2\.3-rc\.1"$/m);
    assert.match(
      local,
      new RegExp(`^installer_sha256="${sha256(installer)}"$`, "m"),
    );
    // Only those lines change.
    const source = readFileSync(
      join(scriptDirectory, "install-k3s.sh"),
      "utf8",
    ).split("\n");
    const differences = local
      .split("\n")
      .filter((line, index) => line !== source[index]);
    assert.equal(differences.length, 2);
    execFileSync("bash", ["-n", join(directory, "install-k3s.sh")]);
  });

  test("rejects a version that is not a plain version string", () => {
    assert.throws(() =>
      execFileSync(
        "bash",
        [
          join(scriptDirectory, "release-installers.sh"),
          "1.2.3/evil",
          directory,
        ],
        {
          stdio: "pipe",
        },
      ),
    );
  });
});

describe("a published install-k3s.sh", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    execFileSync("bash", [
      join(scriptDirectory, "release-installers.sh"),
      "1.2.3",
      directory,
    ]);
  });

  afterEach(() => {
    host.dispose();
  });

  const installerUrl =
    "https://github.com/BenjaminBenetti/everything/releases/download/v1.2.3/install.sh";

  /** Serve this file as the release's install.sh, after its `release_version` line. */
  function serveInstaller(content: string): void {
    const file = join(host.directory, "served-install.sh");
    writeFileSync(file, content);
    host.prepareScript(readFileSync(join(directory, "install-k3s.sh"), "utf8"));
    host.setDownloads({ [installerUrl]: file });
  }

  test("runs its own release's installer, at that version", async () => {
    // A stand-in with the published installer's digest, so the test needs no cluster.
    const published = readFileSync(join(directory, "install.sh"), "utf8");
    const standIn = `${host.read(host.fakeInstaller)}`;
    writeFileSync(join(directory, "install.sh"), standIn);
    const digest = sha256(standIn);
    const local = readFileSync(
      join(directory, "install-k3s.sh"),
      "utf8",
    ).replace(sha256(published), digest);
    writeFileSync(join(directory, "install-k3s.sh"), local);
    serveInstaller(standIn);
    const result = await host.run({
      answers: ["y", "answer"],
      env: { EVERYTHING_VERSION: "0.0.1" },
    });
    assert.equal(result.status, 0, result.output);
    assert.ok(
      host
        .calls()
        .some(
          (call) => call.name === "curl" && call.args.includes(installerUrl),
        ),
    );
    assert.match(host.read(host.installerLog), /^EVERYTHING_VERSION=1\.2\.3$/m);
  });

  test("refuses an installer whose digest differs", async () => {
    serveInstaller("#!/bin/bash\necho tampered\n");
    const result = await host.run({ answers: ["y"] });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /it was not used/);
    assert.doesNotMatch(result.output, /tampered/);
  });

  test("refuses another installer from --installer", async () => {
    serveInstaller("");
    const result = await host.run({
      args: ["--installer", host.fakeInstaller],
      answers: ["y"],
    });
    assert.equal(result.status, 1);
    assert.match(
      result.output,
      /installs Everything 1\.2\.3 with its own installer/,
    );
  });
});

describe("the release workflow", () => {
  test("uploads both installers and gives both commands, keeping the cluster installer's", () => {
    const outputs = join(directory, "outputs");
    writeFileSync(outputs, "");
    runStep(step("Set the installers' release").run ?? "", {
      VERSION: "1.2.3",
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: outputs,
    });
    const values = Object.fromEntries(
      readFileSync(outputs, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2) as [string, string]),
    );
    assert.equal(values.path, join(directory, "installers/install.sh"));
    assert.equal(
      values["local-path"],
      join(directory, "installers/install-k3s.sh"),
    );

    const release = step("Create the GitHub release");
    assert.equal(
      release.env?.LOCAL_INSTALLER,
      "${{ steps.installer.outputs.local-path }}",
    );
    const bin = join(directory, "bin");
    mkdirSync(bin);
    executable(
      join(bin, "gh"),
      `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(join(directory, "gh-args"))}\n`,
    );
    runStep(release.run ?? "", {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: directory,
      GITHUB_REPOSITORY: "BenjaminBenetti/everything",
      GITHUB_REF_NAME: "v1.2.3",
      VERSION: "1.2.3",
      REGISTRY: "ghcr.io/benjaminbenetti/everything",
      CHART: "everything",
      PACKAGE: join(directory, "everything-1.2.3.tgz"),
      INSTALLER: values.path ?? "",
      LOCAL_INSTALLER: values["local-path"] ?? "",
      PRERELEASE: "false",
      PLATFORMS: "linux/amd64,linux/arm64",
      IMAGES:
        '[{"name":"everything","workspace":"services/everything","platforms":"linux/amd64,linux/arm64"}]',
    });
    const args = readFileSync(join(directory, "gh-args"), "utf8").split("\n");
    assert.deepEqual(args.slice(0, 6), [
      "release",
      "create",
      "v1.2.3",
      join(directory, "everything-1.2.3.tgz"),
      join(directory, "installers/install.sh"),
      join(directory, "installers/install-k3s.sh"),
    ]);
    const notes = readFileSync(join(directory, "notes.md"), "utf8");
    assert.ok(
      notes.includes(
        "curl -fsSL https://github.com/BenjaminBenetti/everything/releases/download/v1.2.3/install.sh | bash\n",
      ),
    );
    assert.ok(
      notes.includes(
        "curl -fsSL https://github.com/BenjaminBenetti/everything/releases/download/v1.2.3/install-k3s.sh | bash\n",
      ),
    );
    assert.match(notes, /### Install on this Linux computer/);
    assert.ok(
      notes.indexOf("install.sh | bash") <
        notes.indexOf("helm upgrade everything"),
    );
    assert.ok(
      notes.indexOf("helm upgrade everything") <
        notes.indexOf("install-k3s.sh | bash"),
    );
  });
});
