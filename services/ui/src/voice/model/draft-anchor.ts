/** A range of the draft; empty when it marks a single position. */
export interface DraftSpan {
  readonly start: number;
  readonly end: number;
}

/** One contiguous change: `removed` characters at `start` replaced by `inserted` characters. */
export interface DraftEdit {
  readonly start: number;
  readonly removed: number;
  readonly inserted: number;
}

/** Result of placing a transcript into the draft. */
export type TranscriptInsertion =
  | { readonly draft: string; readonly caret: number }
  | { readonly error: "empty" | "capacity" };

/**
 * Find the single edit that turns one draft into another. The caret after the edit marks where the
 * inserted text ends, which settles ambiguous cases such as typing a letter beside the same letter.
 */
export function draftEdit(
  before: string,
  after: string,
  caret?: number,
): DraftEdit | null {
  if (before === after) return null;
  const shorter = Math.min(before.length, after.length);
  const suffixLimit =
    caret === undefined
      ? shorter
      : Math.max(0, Math.min(shorter, after.length - caret));
  let suffix = 0;
  while (
    suffix < suffixLimit &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  let prefix = 0;
  while (prefix < shorter - suffix && before[prefix] === after[prefix])
    prefix++;
  return {
    start: prefix,
    removed: before.length - prefix - suffix,
    inserted: after.length - prefix - suffix,
  };
}

/**
 * Follow a span through an edit. Edits away from it move it or leave it alone. At a position, text
 * typed there stays after it, so a transcript lands before words typed while it was being
 * transcribed. An edit inside a selected span, or against either of its ends, changes the words it
 * covers, so the span becomes a position after that edit and the transcript is added without
 * replacing anything the user touched.
 */
export function mapSpan(span: DraftSpan, edit: DraftEdit): DraftSpan {
  const editEnd = edit.start + edit.removed;
  const delta = edit.inserted - edit.removed;
  const point = span.start === span.end;
  if (point ? edit.start >= span.end : edit.start > span.end) return span;
  if (point ? editEnd <= span.start : editEnd < span.start)
    return { start: span.start + delta, end: span.end + delta };
  const position =
    editEnd < span.end ? span.end + delta : edit.start + edit.inserted;
  return { start: position, end: position };
}

/** Characters a transcript joins without a space before it. */
const openingPunctuation = /[\s([{"'“‘]$/u;

/** Characters a transcript is separated from by a space after it. */
const wordStart = /^[\p{L}\p{N}]/u;

/**
 * Replace the span with the trimmed transcript, adding a space on either side where it would
 * otherwise run into a word. Nothing changes when the transcript is empty or the result would not
 * fit in a message, so no recognized words are silently cut.
 */
export function insertTranscript(
  draft: string,
  span: DraftSpan,
  transcript: string,
  maxLength: number,
): TranscriptInsertion {
  const text = transcript.trim();
  if (!text) return { error: "empty" };
  const before = draft.slice(0, span.start);
  const after = draft.slice(span.end);
  const lead = before && !openingPunctuation.test(before) ? " " : "";
  const trail = wordStart.test(after) ? " " : "";
  const next = `${before}${lead}${text}${trail}${after}`;
  if (next.length > maxLength) return { error: "capacity" };
  return { draft: next, caret: before.length + lead.length + text.length };
}
