import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  bashInput,
  fileReadInput,
  fileWriteInput,
} from "@everything/workspace-contracts";
import {
  sharedWorkspacePath,
  workspacePath,
} from "@everything/workspace-contracts/mount";
import type { WorkspaceTools } from "../../workspace/interface/workspace-tools.js";

export const workspaceToolNames = {
  read: "file_read",
  write: "file_write",
  bash: "bash",
} as const;

/** Serialize bounded tool results for model consumption. */
function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

/** Bind tools to the current teammate; neither identity nor API destination is model-controlled. */
export function workspaceTools(workspace: WorkspaceTools, agentId: string) {
  return [
    defineTool({
      name: workspaceToolNames.read,
      label: "Read file",
      description: `Read a UTF-8 file in your workspace, or in ${sharedWorkspacePath}, the folder every teammate shares. Relative paths are in your workspace. Reads return up to 128 KiB; pass nextOffset as offset to continue.`,
      parameters: fileReadInput,
      /** Read through the teammate's pod API. */
      async execute(_id, input, signal) {
        return result(await workspace.read(agentId, input, signal));
      },
    }),
    defineTool({
      name: workspaceToolNames.write,
      label: "Write file",
      description: `Create or replace a UTF-8 file in your workspace, or in ${sharedWorkspacePath} to hand it to other teammates, creating parent directories. Relative paths are in your workspace. Maximum content size is 1 MiB.`,
      parameters: fileWriteInput,
      /** Write through the teammate's pod API. */
      async execute(_id, input, signal) {
        return result(await workspace.write(agentId, input, signal));
      },
    }),
    defineTool({
      name: workspaceToolNames.bash,
      label: "Run Bash",
      description:
        `Run a Bash command in your teammate pod. Your workspace is ${workspacePath(agentId)}, which is also HOME; ${sharedWorkspacePath} is shared with every teammate. Optional cwd is relative to your workspace. Defaults to a 30-second timeout (maximum 120). Returns stdout/stderr, exit status, and truncation/timeout flags. Processes are stopped when the command completes or is interrupted; publish or deploy an app for persistent hosting. ` +
        "Installed: Node.js with npm, Python 3 with pip and venv, Ruby with gem and bundler, Go, gcc/g++/make, git, curl, jq, and Chromium (`chromium --headless --screenshot=shot.png <url>`; its D-Bus errors are harmless). Puppeteer finds Chromium automatically; Playwright needs `executablePath: process.env.CHROME_PATH`. " +
        "There is no root or apt-get. User-level installs (pip install --user, npm install -g, gem install, go install) persist in ~/.local and are on PATH; download and build caches in /tmp are cleared when the pod restarts.",
      parameters: bashInput,
      /** Execute outside Everything and propagate interruption. */
      async execute(_id, input, signal) {
        return result(await workspace.bash(agentId, input, signal));
      },
    }),
  ];
}
