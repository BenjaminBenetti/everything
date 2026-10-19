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

/** Text written over a span, and the span that now holds everything written. */
export interface DraftWrite {
  readonly draft: string;
  readonly span: DraftSpan;
  /** Where the text itself ends, before any space added after it. */
  readonly textEnd: number;
}

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
 * Write text over the span, adding a space on either side where it would otherwise run into a word.
 * The returned span covers the spaces too, so writing over it again replaces exactly this text and
 * never adds a second space.
 */
export function writeSpaced(
  draft: string,
  span: DraftSpan,
  text: string,
): DraftWrite {
  const before = draft.slice(0, span.start);
  const after = draft.slice(span.end);
  const lead = before && !openingPunctuation.test(before) ? " " : "";
  const trail = wordStart.test(after) ? " " : "";
  const written = `${lead}${text}${trail}`;
  return {
    draft: `${before}${written}${after}`,
    span: { start: span.start, end: span.start + written.length },
    textEnd: span.start + lead.length + text.length,
  };
}

/** Write text over the span exactly as given, as when putting back the text a dictation replaced. */
export function writeExact(
  draft: string,
  span: DraftSpan,
  text: string,
): DraftWrite {
  const end = span.start + text.length;
  return {
    draft: `${draft.slice(0, span.start)}${text}${draft.slice(span.end)}`,
    span: { start: span.start, end },
    textEnd: end,
  };
}

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
  const written = writeSpaced(draft, span, text);
  if (written.draft.length > maxLength) return { error: "capacity" };
  return { draft: written.draft, caret: written.textEnd };
}

// ===========================================
// Live dictation text
// ===========================================

/**
 * Follow text a dictation has written, and still owns, through a user's edit. Edits before or
 * after it move it or leave it alone, and text typed at either end stays outside it, so a later
 * revision never overwrites it. Null when the edit changes the dictation's own text.
 */
export function mapOwned(span: DraftSpan, edit: DraftEdit): DraftSpan | null {
  const delta = edit.inserted - edit.removed;
  if (edit.start >= span.end) return span;
  if (edit.start + edit.removed <= span.start)
    return { start: span.start + delta, end: span.end + delta };
  return null;
}

/** The owned span grown to take in an edit that changed it, in the edited draft's positions. */
export function absorbEdit(span: DraftSpan, edit: DraftEdit): DraftSpan {
  return {
    start: Math.min(span.start, edit.start),
    end: Math.max(
      span.end + edit.inserted - edit.removed,
      edit.start + edit.inserted,
    ),
  };
}

/**
 * Where a selection belongs after the dictation rewrote its span `from` as `to`, which starts at the
 * same place. A selection elsewhere keeps its text. One at the dictation's text, inside it, or
 * exactly over it follows the dictation to `follow`; one just before non-empty text stays before.
 * Without a selection, the caret follows.
 */
export function followSelection(
  selection: DraftSpan | undefined,
  from: DraftSpan,
  to: DraftSpan,
  follow: number,
): DraftSpan {
  if (
    !selection ||
    (selection.start === from.start && selection.end === from.end)
  )
    return { start: follow, end: follow };
  const place = (position: number): number =>
    position < from.start
      ? position
      : position > from.end
        ? position + to.end - from.end
        : position === from.start && from.start < from.end
          ? to.start
          : follow;
  const start = place(selection.start);
  return { start, end: Math.max(start, place(selection.end)) };
}

/**
 * Restate a user's edit, made to `base`, against the draft the dictation has since changed it to.
 * The edit keeps its own text and moves past the dictation's change. Null when the two changed the
 * same text.
 */
export function rebaseEdit(
  base: string,
  value: string,
  caret: number | undefined,
  current: string,
): { readonly value: string; readonly caret: number } | null {
  const user = draftEdit(base, value, caret);
  const dictation = draftEdit(base, current);
  if (!user || !dictation)
    return { value: user ? value : current, caret: caret ?? 0 };
  const dictationEnd = dictation.start + dictation.removed;
  let start: number;
  if (user.start >= dictationEnd)
    start = user.start + dictation.inserted - dictation.removed;
  else if (user.start + user.removed <= dictation.start) start = user.start;
  else return null;
  const inserted = value.slice(user.start, user.start + user.inserted);
  return {
    value: `${current.slice(0, start)}${inserted}${current.slice(start + user.removed)}`,
    caret: start + user.inserted,
  };
}
