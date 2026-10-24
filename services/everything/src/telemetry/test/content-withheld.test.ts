import assert from "node:assert/strict";
import { test } from "node:test";
import { sendMessageToolName } from "../../runtime/model/message-delivery.js";
import {
  telemetryAttributes as attribute,
  telemetrySpans,
} from "../model/telemetry-attributes.js";
import { reply, settled, teammate } from "./runtime-fixtures.js";
import {
  exportedText,
  spansNamed,
  startInMemoryTelemetry,
} from "./telemetry-fixtures.js";

// An installation that set `telemetry.includeContent: false` and kept error text.
const telemetry = startInMemoryTelemetry({
  includeErrorText: true,
  includeContent: false,
});

test("with content withheld, no message or tool argument reaches the export, and the spans say it was withheld", async (context) => {
  telemetry.reset();
  const message = "Natural private plan: we launch next Tuesday";
  const answer = "Natural private answer: Tuesday works";
  const { runtime, deliveries } = await teammate(context, ({ attempt }) =>
    attempt === 1
      ? reply("", { name: sendMessageToolName, input: { text: answer } })
      : reply("Done."),
  );
  runtime.start(message);
  await settled(runtime);
  assert.deepEqual(deliveries, [answer], "the tool still ran unchanged");
  const exported = await telemetry.collect();
  const text = exportedText(exported);
  assert.ok(!text.includes("Natural private"), "no content is exported");
  for (const key of [
    attribute.messagePreview,
    attribute.messageLength,
    attribute.toolArguments,
    attribute.toolArgumentsTruncated,
  ])
    assert.ok(
      exported.spans.every((span) => span.attributes[key] === undefined),
      key,
    );
  const [turn] = spansNamed(exported, telemetrySpans.turn);
  const [tool] = spansNamed(exported, telemetrySpans.tool);
  assert.equal(turn?.attributes[attribute.contentWithheld], true);
  assert.equal(tool?.attributes[attribute.contentWithheld], true);
  assert.equal(tool?.attributes[attribute.tool], sendMessageToolName);
  for (const prompt of spansNamed(exported, telemetrySpans.prompt))
    assert.equal(
      prompt.attributes[attribute.contentWithheld],
      undefined,
      "a span that had no content isn't marked",
    );
});
