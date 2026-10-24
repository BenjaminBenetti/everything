import assert from "node:assert/strict";
import { test } from "node:test";
import { telemetryLimits } from "@everything/telemetry-contracts";
import { sendMessageToolName } from "../../runtime/model/message-delivery.js";
import { replyDeliveryPrompt } from "../../runtime/prompt/reply-delivery-prompt.js";
import {
  telemetryAttributes as attribute,
  telemetrySpans,
} from "../model/telemetry-attributes.js";
import { utf8Length } from "../service/text-budget.js";
import { reply, settled, sse, teammate } from "./runtime-fixtures.js";
import {
  exportedText,
  spansNamed,
  startInMemoryTelemetry,
} from "./telemetry-fixtures.js";

// Content and error text recorded, as installations do by default.
const telemetry = startInMemoryTelemetry({
  includeErrorText: true,
  includeContent: true,
});

/** A synthetic key in a shape the redactor recognizes. */
const key = "sk-proj-contentcanaryabcdefghijkl";

/** Thinking a model streams, which telemetry never records. */
const thinking = "PRIVATE-THINKING-CANARY the user seems stressed";

/** A phrase of the instructions Everything gives every teammate, which telemetry never records. */
const instructions =
  "Treat this description as your role, and follow it in everything you do.";

/** A streamed response that thinks before replying with `text`. */
function thoughtfulReply(text: string): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: "completion",
    object: "chat.completion.chunk",
    created: 1,
    model: "o3-mini",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return sse([
    chunk({ role: "assistant", reasoning_content: thinking }, null),
    chunk({ content: text }, "stop"),
  ]);
}

test("a turn records the message it answered once, redacted, and its tool calls' arguments, never reminders, instructions, or thinking", async (context) => {
  telemetry.reset();
  const message = `Plan the launch. The staging password=hunter2 and key ${key} are in the vault.`;
  const answer = `Here's the plan; I won't repeat ${key}.`;
  const requests: string[] = [];
  const { runtime, deliveries } = await teammate(
    context,
    ({ attempt, body }) => {
      requests.push(body);
      // The model thinks and replies without delivering, gets the reminder, then delivers.
      if (attempt === 1) return thoughtfulReply("I should answer.");
      if (attempt === 2)
        return reply("", {
          name: sendMessageToolName,
          input: { text: answer },
        });
      return reply("Done.");
    },
  );
  runtime.start(message);
  await settled(runtime);
  assert.equal(runtime.status.status, "idle");
  assert.deepEqual(
    deliveries,
    [answer],
    "the tool ran with exactly the arguments the model gave it",
  );
  assert.ok(
    requests.some((body) => body.includes("Internal delivery reminder")),
    "the reminder reached the model",
  );
  const exported = await telemetry.collect();
  const text = exportedText(exported);

  const [turn] = spansNamed(exported, telemetrySpans.turn);
  assert.ok(turn);
  assert.equal(
    turn.attributes[attribute.messagePreview],
    "Plan the launch. The staging password=[redacted] and key [redacted] are in the vault.",
  );
  assert.equal(turn.attributes[attribute.messageLength], message.length);
  assert.equal(turn.attributes[attribute.messageTruncated], false);
  assert.equal(
    exported.spans.filter((span) => span.attributes[attribute.messagePreview])
      .length,
    1,
    "only the turn holds the message",
  );
  const prompts = spansNamed(exported, telemetrySpans.prompt);
  assert.ok(prompts.length >= 2, "the user's prompt and the reminder's");

  const [tool] = spansNamed(exported, telemetrySpans.tool);
  assert.equal(tool?.attributes[attribute.tool], sendMessageToolName);
  assert.deepEqual(
    JSON.parse(String(tool?.attributes[attribute.toolArguments])),
    { text: "Here's the plan; I won't repeat [redacted]." },
  );
  assert.equal(tool?.attributes[attribute.toolArgumentsTruncated], false);

  for (const secret of [key, "hunter2", thinking, instructions])
    assert.ok(!text.includes(secret), `${secret} is never exported`);
  assert.ok(
    !text.includes(replyDeliveryPrompt.slice(0, 60)),
    "Everything's reminder is never exported",
  );
});

test("a tool call's oversized arguments are previewed within the budget, and a long message by its start and end", async (context) => {
  telemetry.reset();
  const file = `${"export const value = 1;\n".repeat(2_000)}// end of file`;
  const question = "Why does the build fail?";
  const { runtime } = await teammate(context, ({ attempt }) => {
    if (attempt === 1)
      return reply("", {
        name: "write_notes",
        input: {
          path: "src/value.ts",
          content: file,
          credentials: { apiKey: key },
          screenshot: `data:image/png;base64,${"iVBORw0KGgo".repeat(2_000)}`,
        },
      });
    if (attempt === 2)
      return reply("", {
        name: sendMessageToolName,
        input: { text: "Fixed." },
      });
    return reply("Done.");
  });
  runtime.start(
    `${"Build output: error TS2322 in value.ts\n".repeat(500)}${question}`,
  );
  await settled(runtime);
  const exported = await telemetry.collect();
  const [turn] = spansNamed(exported, telemetrySpans.turn);
  const preview = String(turn?.attributes[attribute.messagePreview]);
  assert.equal(turn?.attributes[attribute.messageTruncated], true);
  assert.ok(preview.startsWith("Build output: error TS2322"));
  assert.ok(preview.endsWith(question), "the question after the paste is kept");
  assert.ok(utf8Length(preview) <= telemetryLimits.previewBytes);

  const tool = spansNamed(exported, telemetrySpans.tool).find(
    (span) => span.attributes[attribute.tool] === "write_notes",
  );
  assert.ok(tool, "a call to a tool that doesn't exist is still previewed");
  const args = String(tool.attributes[attribute.toolArguments]);
  assert.ok(utf8Length(args) <= telemetryLimits.previewBytes);
  assert.equal(tool.attributes[attribute.toolArgumentsTruncated], true);
  const parsed = JSON.parse(args) as Record<string, unknown>;
  assert.equal(parsed.path, "src/value.ts");
  assert.match(String(parsed.content), /^export const value = 1;/);
  assert.match(String(parsed.content), /truncated from \d+ characters/);
  assert.deepEqual(parsed.credentials, "[redacted]");
  assert.match(String(parsed.screenshot), /^\[data URL of image\/png/);
  assert.ok(!exportedText(exported).includes(key));
  assert.ok(!exportedText(exported).includes("iVBORw0KGgoiVBOR"));
});
