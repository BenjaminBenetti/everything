/** Replacement for half of a surrogate pair, which has no UTF-8 encoding of its own. */
const replacementCharacter = "�";

/** UTF-8 bytes one code point takes. */
function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** The code point at `index`, or a replacement character's for half of a surrogate pair. */
function codePointAt(text: string, index: number): number {
  const codePoint = text.codePointAt(index)!;
  return codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint;
}

/** UTF-16 units the code point at `index` takes: two for a pair, one otherwise. */
function unitsAt(text: string, index: number): number {
  return (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

/**
 * UTF-8 bytes `text` takes, counting a lone surrogate as the replacement character it is encoded
 * as. Counting stops once it passes `stopAfter`, so measuring long text against a budget is bounded.
 */
export function utf8Length(
  text: string,
  stopAfter = Number.POSITIVE_INFINITY,
): number {
  let bytes = 0;
  for (let index = 0; index < text.length && bytes <= stopAfter;) {
    bytes += utf8Size(codePointAt(text, index));
    index += unitsAt(text, index);
  }
  return bytes;
}

/**
 * The longest start of `text` that fits in `maxBytes` of UTF-8, whole characters only, with lone
 * surrogates replaced so the result is always valid UTF-8. Only as much of `text` is read as fits.
 */
export function utf8Head(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = codePointAt(text, index);
    const size = utf8Size(codePoint);
    if (bytes + size > maxBytes) break;
    const units = unitsAt(text, index);
    if (codePoint === 0xfffd && text[index] !== replacementCharacter) {
      result += text.slice(start, index) + replacementCharacter;
      start = index + units;
    }
    bytes += size;
    index += units;
  }
  return result + text.slice(start, index);
}

/**
 * The longest end of `text` that fits in `maxBytes` of UTF-8, whole characters only, with lone
 * surrogates replaced. Only as much of `text` is read as fits.
 */
export function utf8Tail(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = text.length;
  while (index > 0) {
    // A low surrogate preceded by a high one is the second half of one character.
    const low = text.charCodeAt(index - 1);
    const high = index >= 2 ? text.charCodeAt(index - 2) : 0;
    const pair =
      low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
    const start = index - (pair ? 2 : 1);
    const size = utf8Size(codePointAt(text, start));
    if (bytes + size > maxBytes) break;
    bytes += size;
    index = start;
  }
  return utf8Head(text.slice(index), maxBytes);
}

/** Text cut to a byte budget, and whether anything was cut. */
export interface FittedText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * `text` within `maxBytes` of UTF-8: unchanged when it fits, otherwise its start followed by
 * `marker`, both counted in the budget.
 */
export function fitUtf8(
  text: string,
  maxBytes: number,
  marker: string,
): FittedText {
  if (utf8Length(text, maxBytes) <= maxBytes)
    return { text: utf8Head(text, maxBytes), truncated: false };
  return {
    text: utf8Head(text, Math.max(0, maxBytes - utf8Length(marker))) + marker,
    truncated: true,
  };
}
