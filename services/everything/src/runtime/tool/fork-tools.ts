import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { messageTextMaxLength } from "../../conversation/model/message.js";
import type { SessionForkOperations } from "../interface/session-forks.js";
import { concurrentForkLimit, forkToolNames } from "../model/fork-policy.js";
export { forkToolNames } from "../model/fork-policy.js";

/** Return private routing information without exposing session paths or model settings. */
function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

/** Bind private fork tools to the current session's trusted sender identity. */
export function forkTools(operations: SessionForkOperations) {
  const text = Type.String({ minLength: 1, maxLength: messageTextMaxLength });
  const address = Type.String({ minLength: 1, maxLength: 128 });
  return [
    defineTool({
      name: forkToolNames.fork,
      label: "Fork teammate",
      description: `Start a background teammate with your model, effort, instructions, tools, and shared workspace. It starts with fresh conversation context by default; set context to true to copy your current history. Give it a self-contained task with the information it needs. Returns its ID immediately after opening it, and supports private messages both ways. Up to ${concurrentForkLimit} forks can work at once.`,
      parameters: Type.Object(
        {
          task: text,
          context: Type.Optional(
            Type.Boolean({
              default: false,
              description:
                "Copy your current conversation history into the fork. Defaults to false: start with only the assigned task and shared instructions.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      /** Open the fork without waiting for its work to finish. */
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        return result(
          await operations.fork(input.task, input.context ?? false),
        );
      },
    }),
    defineTool({
      name: forkToolNames.send,
      label: "Message fork",
      description:
        "Send a private message to a fork ID, main, or your parent. Wakes an idle recipient; a busy recipient reads it after its current turn. Returns without waiting for a reply. These messages are not shown to the user.",
      parameters: Type.Object(
        { recipient: address, text },
        { additionalProperties: false },
      ),
      /** Queue delivery within this teammate's family only. */
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        operations.send(input.recipient, input.text);
        return result({ delivered: true });
      },
    }),
    defineTool({
      name: forkToolNames.list,
      label: "List forks",
      description:
        "List your teammate's private forks, their parent IDs, and whether they are working, queued, idle, stopped, or failed. Send a message to resume an idle or stopped fork. Messages wait for a free slot when eight forks are working.",
      parameters: Type.Object({}, { additionalProperties: false }),
      /** Inspect only this teammate's private sessions. */
      async execute(_id, _input, signal) {
        signal?.throwIfAborted();
        return result(operations.list());
      },
    }),
    defineTool({
      name: forkToolNames.stop,
      label: "Stop fork",
      description:
        "Stop one of your descendant forks and all of its children, retaining their histories for later messages.",
      parameters: Type.Object({ id: address }, { additionalProperties: false }),
      /** Wait for the descendant's tools to settle before confirming cancellation. */
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        await operations.stop(input.id);
        return result({ stopped: true });
      },
    }),
  ];
}
