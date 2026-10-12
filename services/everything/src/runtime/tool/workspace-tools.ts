import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  bashInput,
  fileReadInput,
  fileWriteInput,
} from "@everything/workspace-contracts";
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
      description:
        "Read a UTF-8 file in your workspace. Use relative paths. Reads return up to 128 KiB; pass nextOffset as offset to continue.",
      parameters: fileReadInput,
      /** Read through the teammate's pod API. */
      async execute(_id, input, signal) {
        return result(await workspace.read(agentId, input, signal));
      },
    }),
    defineTool({
      name: workspaceToolNames.write,
      label: "Write file",
      description:
        "Create or replace a UTF-8 file in your workspace, creating parent directories. Use relative paths. Maximum content size is 1 MiB.",
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
        "Run a Bash command in your teammate pod. The workspace is /workspace. Optional cwd is relative to it. Defaults to a 30-second timeout (maximum 120). Returns stdout/stderr, exit status, and truncation/timeout flags. Processes are stopped when the command completes or is interrupted; use artifacts for persistent apps.",
      parameters: bashInput,
      /** Execute outside Everything and propagate interruption. */
      async execute(_id, input, signal) {
        return result(await workspace.bash(agentId, input, signal));
      },
    }),
  ];
}
