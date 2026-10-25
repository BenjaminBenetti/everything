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

// Content recorded, as installations do by default.
const telemetry = startInMemoryTelemetry({
  includeErrorText: true,
  includeContent: true,
});

/** A deliberately fake key, percent-encoded as a URL path would carry it; REVIEWFAKE marks it. */
const encodedKey = "sk%2Dproj%2DREVIEWFAKEpipe0001abcdefgh";

test("P1: encoded credentials in a real conversation message and in real tool call arguments are redacted before export, and the tool still receives them", async (context) => {
  telemetry.reset();
  const message = `Call https://gateway.test/v1/${encodedKey}/messages with api%5Fkey%3DREVIEWFAKEpipe02 please`;
  // The send-message tool accepts only its text; another call carries an encoded field name.
  const args = { text: `Using https://gateway.test/v1/${encodedKey}/messages` };
  const inspected = {
    "api%5Fkey": "REVIEWFAKEpipe03",
    nested: { note: "token%3DREVIEWFAKEpipe04" },
  };
  const { runtime, deliveries } = await teammate(context, ({ attempt }) => {
    if (attempt === 1)
      return reply("", { name: sendMessageToolName, input: args });
    if (attempt === 2)
      return reply("", { name: "inspect_request", input: inspected });
    return reply("Done.");
  });
  runtime.start(message);
  await settled(runtime);
  assert.deepEqual(
    deliveries,
    [args.text],
    "the tool received its arguments exactly",
  );
  const exported = await telemetry.collect();
  const text = exportedText(exported);
  for (const canary of [
    "REVIEWFAKEpipe0001",
    "REVIEWFAKEpipe02",
    "REVIEWFAKEpipe03",
    "REVIEWFAKEpipe04",
  ])
    assert.ok(!text.includes(canary), `${canary} reached the export`);
  const [turn] = spansNamed(exported, telemetrySpans.turn);
  assert.match(
    String(turn?.attributes[attribute.messagePreview]),
    /^Call https:\/\/gateway\.test\/v1\//,
    "the rest of the message is kept",
  );
  const tools = spansNamed(exported, telemetrySpans.tool);
  assert.deepEqual(
    tools.map((tool) => tool.attributes[attribute.tool]).sort(),
    ["inspect_request", sendMessageToolName].sort(),
  );
  assert.ok(tools.every((tool) => tool.attributes[attribute.toolArguments]));
});
