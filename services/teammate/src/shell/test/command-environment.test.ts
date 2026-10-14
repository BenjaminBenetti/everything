import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkspaceFiles } from "../../workspace/service/workspace-files.js";
import { BashRunner } from "../service/bash-runner.js";
import { commandEnvironment } from "../model/command-environment.js";
import { LinuxCommandProcessFactory } from "../adapter/linux-command-process-factory.js";

const home = "/workspace/6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

test("command environment forwards only allowlisted variables and installs into the workspace", () => {
  assert.deepEqual(
    commandEnvironment(
      {
        PATH: "/usr/bin:/bin",
        GOPATH: "/elsewhere/go",
        CHROME_PATH: "/usr/bin/chromium",
        WORKSPACE_TOKEN: "a".repeat(64),
        NODE_ENV: "production",
        PORT: "8080",
        HOME: "/elsewhere",
      },
      home,
    ),
    {
      PATH: `${home}/.local/bin:${home}/.local/share/gem/bin:/usr/bin:/bin`,
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      CHROME_PATH: "/usr/bin/chromium",
      HOME: home,
      NPM_CONFIG_PREFIX: `${home}/.local`,
      GEM_HOME: `${home}/.local/share/gem`,
      GOPATH: `${home}/.local/share/go`,
      GOBIN: `${home}/.local/bin`,
    },
  );
});

test("Bash uses the workspace as HOME from any working directory and sees only the given environment", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "teammate-shell-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "project"));
  const bash = new BashRunner(
    new WorkspaceFiles(root, path.join(root, "shared")),
    new LinuxCommandProcessFactory(),
    commandEnvironment(
      { PATH: process.env.PATH, WORKSPACE_TOKEN: "never inherited" },
      root,
    ),
  );
  const result = await bash.run({
    command:
      'printf "%s|%s|%s|%s|%s" "$HOME" "$PWD" "$GEM_HOME" "$TMPDIR" "${WORKSPACE_TOKEN-unset}"',
    cwd: "project",
  });
  assert.equal(
    result.output,
    `${root}|${path.join(root, "project")}|${root}/.local/share/gem|/tmp|unset`,
  );
});
