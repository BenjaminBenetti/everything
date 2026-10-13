import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkspaceFiles } from "../../workspace/service/workspace-files.js";
import { BashRunner } from "../service/bash-runner.js";
import { commandEnvironment } from "../model/command-environment.js";
import { LinuxCommandProcessFactory } from "../adapter/linux-command-process-factory.js";

test("command environment forwards only allowlisted variables, with minimal fallbacks", () => {
  assert.deepEqual(
    commandEnvironment({
      PATH: "/workspace/.local/bin:/usr/bin:/bin",
      GOPATH: "/workspace/.local/share/go",
      CHROME_PATH: "/usr/bin/chromium",
      WORKSPACE_TOKEN: "a".repeat(64),
      NODE_ENV: "production",
      PORT: "8080",
      HOME: "/elsewhere",
    }),
    {
      PATH: "/workspace/.local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      GOPATH: "/workspace/.local/share/go",
      CHROME_PATH: "/usr/bin/chromium",
    },
  );
});

test("Bash uses the workspace as HOME from any working directory and sees only the given environment", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "teammate-shell-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "project"));
  const bash = new BashRunner(
    new WorkspaceFiles(root),
    new LinuxCommandProcessFactory(),
    commandEnvironment({
      PATH: process.env.PATH,
      GEM_HOME: "/workspace/.local/share/gem",
      WORKSPACE_TOKEN: "never inherited",
    }),
  );
  const result = await bash.run({
    command:
      'printf "%s|%s|%s|%s|%s" "$HOME" "$PWD" "$GEM_HOME" "$TMPDIR" "${WORKSPACE_TOKEN-unset}"',
    cwd: "project",
  });
  assert.equal(
    result.output,
    `${root}|${path.join(root, "project")}|/workspace/.local/share/gem|/tmp|unset`,
  );
});
