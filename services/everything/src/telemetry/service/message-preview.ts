import { telemetryLimits } from "@everything/telemetry-contracts";
import { redactEnd, redactStart } from "./telemetry-redactor.js";
import { utf8Head, utf8Length, utf8Tail } from "./text-budget.js";

/** A message's preview, as recorded on the turn that answered it. */
export interface MessagePreview {
  /** The redacted message, or its start and end when it is longer than the budget. */
  readonly text: string;
  /** Characters in the whole message. */
  readonly length: number;
  /** Part of the message isn't in the preview. */
  readonly truncated: boolean;
}

/** Where a long message's preview leaves out its middle. */
export const messageGapMarker = "\n…[middle of the message not shown]…\n";

/** UTF-8 bytes of a long message's end kept in its preview, where a question often is. */
const tailBytes = 500;

/**
 * A bounded, redacted preview of a message sent to a teammate: the whole message when it fits in
 * `telemetryLimits.previewBytes` of UTF-8, otherwise its start and its end with the middle left
 * out, so a question after a long paste stays visible. Credentials are redacted before the text is
 * measured, and only the start and end of a long message are read.
 */
export function messagePreview(
  message: string,
  budget: number = telemetryLimits.previewBytes,
): MessagePreview {
  const length = characterCount(message);
  const window = budget * 2 + 512;
  const start = redactStart(message, window);
  const whole = start.text.trim();
  if (!start.cut && utf8Length(whole, budget) <= budget)
    return { text: whole, length, truncated: false };
  // Without a cut, the end comes from the same redacted text, so the two parts never overlap.
  const end = start.cut ? redactEnd(message, window).text : start.text;
  const tail = utf8Tail(end, Math.min(tailBytes, budget / 4)).trimStart();
  const head = utf8Head(
    start.text,
    Math.max(0, budget - utf8Length(messageGapMarker) - utf8Length(tail)),
  ).trimEnd();
  return { text: `${head}${messageGapMarker}${tail}`, length, truncated: true };
}

/** Characters in `text`, counting a surrogate pair as one. */
function characterCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      index++;
    count++;
  }
  return count;
}
