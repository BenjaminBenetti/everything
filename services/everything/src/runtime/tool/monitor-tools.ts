import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  monitorInput,
  monitorLimits,
} from "@everything/workspace-contracts/monitor";
import type {
  MonitorOperations,
  MonitorScope,
} from "../../monitor/interface/monitor-operations.js";
import {
  monitorInstructionsMaxLength,
  monitorToolNames,
} from "../../monitor/model/monitor-policy.js";
import { workspaceToolNames } from "./workspace-tools.js";
export { monitorToolNames } from "../../monitor/model/monitor-policy.js";

/** Serialize bounded tool results for model consumption. */
function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

/**
 * Bind monitor tools to the teammate that owns this session; `origin` is main or this fork's ID.
 * Completion events always go to `scope`'s teammate, never to a model-chosen recipient.
 */
export function monitorTools(
  monitors: MonitorOperations,
  scope: MonitorScope,
  origin: string,
) {
  const id = Type.String({ format: "uuid" });
  return [
    defineTool({
      name: monitorToolNames.start,
      label: "Monitor command",
      description:
        `Start a Bash command in the background and return its monitor ID right away, so you can keep working or finish your turn. It runs like ${workspaceToolNames.bash}: same pod, environment, workspace, and optional cwd. When it finishes, fails, or times out, a temporary background session with fresh context receives its exit status and output and reports to main. ` +
        `Use instructions to say what that session should do with the result, because it won't see this conversation. Default timeout is ${monitorLimits.defaultTimeoutSeconds / 60} minutes (maximum ${monitorLimits.timeoutSeconds / 3600} hours). The event includes the beginning and end of long output; the full log, up to ${monitorLimits.logBytes / 1024 / 1024} MiB, is at the returned log path. ` +
        `Up to ${monitorLimits.concurrent} monitors can run at once. Monitors keep running after your turn and new user messages; the user's Stop action, ${monitorToolNames.stop}, and restarts stop them.`,
      parameters: Type.Object(
        {
          ...monitorInput.properties,
          instructions: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: monitorInstructionsMaxLength,
              description:
                "What to do when the command finishes, such as who to tell or which follow-up to run.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      /** Start the command; the turn's interruption applies only until the pod has launched it. */
      async execute(_id, input, signal) {
        return result({
          ...(await monitors.start(scope, origin, input, signal)),
          status: "running",
        });
      },
    }),
    defineTool({
      name: monitorToolNames.list,
      label: "List monitors",
      description:
        "List your monitors that are still running, with their IDs, commands, who started them, and log paths.",
      parameters: Type.Object({}, { additionalProperties: false }),
      /** Inspect only this teammate's monitors. */
      async execute(_id, _input, signal) {
        signal?.throwIfAborted();
        return result(monitors.list(scope));
      },
    }),
    defineTool({
      name: monitorToolNames.stop,
      label: "Stop monitor",
      description:
        "Stop a running monitor and its processes. Returns its status and output here instead of sending a completion event.",
      parameters: Type.Object({ id }, { additionalProperties: false }),
      /** Stop only this teammate's monitor. */
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        return result(await monitors.stop(scope, input.id));
      },
    }),
  ];
}
