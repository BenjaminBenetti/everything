import assert from "node:assert/strict";
import { test } from "node:test";
import {
  committedDraft,
  composerReducer,
  initialComposerState,
  type ComposerAction,
  type ComposerState,
} from "../model/composer-state.js";

/** Apply actions in order. */
function run(
  state: ComposerState,
  ...actions: ComposerAction[]
): ComposerState {
  return actions.reduce(composerReducer, state);
}

/** A composer holding a draft with no dictation. */
function drafted(draft: string): ComposerState {
  return { ...initialComposerState, draft };
}

/** Press Space at a selection and let the browser type the space. */
function holdSpace(
  state: ComposerState,
  selectionStart: number,
  selectionEnd = selectionStart,
  at = 1_000,
): ComposerState {
  const typed =
    state.draft.slice(0, selectionStart) +
    " " +
    state.draft.slice(selectionEnd);
  return run(
    state,
    { type: "spaceDown", at, selectionStart, selectionEnd },
    { type: "edit", value: typed, caret: selectionStart + 1 },
  );
}

test("a Space hold promotes at exactly 1000 ms, not 999 ms, once, restoring the text the space replaced", () => {
  const armed = holdSpace(drafted("Say hello"), 3);
  assert.equal(armed.draft, "Say  hello");
  assert.equal(armed.voice.phase, "arming");
  const { generation } = armed.voice;
  const early = run(armed, { type: "holdTick", generation, now: 1_999 });
  assert.equal(early, armed);
  const promoted = run(armed, { type: "holdTick", generation, now: 2_000 });
  assert.equal(promoted.voice.phase, "starting");
  // Later ticks of the same hold start nothing more.
  assert.equal(
    run(promoted, { type: "holdTick", generation, now: 2_500 }),
    promoted,
  );
  assert.equal(promoted.draft, "Say hello");
  assert.deepEqual(promoted.voice.target, { start: 3, end: 3 });
  assert.equal(promoted.voice.selection?.start, 3);
  // A tick for another generation is ignored.
  assert.equal(
    run(armed, { type: "holdTick", generation: generation + 1, now: 9_000 }),
    armed,
  );
});

test("promoting over a selection restores the selected text and selects it again for replacement", () => {
  const armed = holdSpace(drafted("Use OLD here"), 4, 7);
  assert.equal(armed.draft, "Use   here");
  const promoted = run(armed, {
    type: "holdTick",
    generation: armed.voice.generation,
    now: 5_000,
  });
  assert.equal(promoted.draft, "Use OLD here");
  assert.deepEqual(promoted.voice.target, { start: 4, end: 7 });
  assert.deepEqual(
    {
      start: promoted.voice.selection?.start,
      end: promoted.voice.selection?.end,
    },
    { start: 4, end: 7 },
  );
});

test("a short press, another edit, or a selection move ends the hold and keeps the typed text", () => {
  const armed = holdSpace(drafted("Hi"), 2);
  const tapped = run(armed, { type: "cancel" });
  assert.equal(tapped.draft, "Hi ");
  assert.equal(tapped.voice.phase, "idle");
  // Typing the next letter before the hold completes.
  const typed = run(armed, { type: "edit", value: "Hi t", caret: 4 });
  assert.equal(typed.draft, "Hi t");
  assert.equal(typed.voice.phase, "idle");
  // The space's own caret move is expected; a click elsewhere is not.
  assert.equal(run(armed, { type: "select", start: 3, end: 3 }), armed);
  const moved = run(armed, { type: "select", start: 0, end: 0 });
  assert.equal(moved.voice.phase, "idle");
  assert.equal(moved.draft, "Hi ");
});

test("a hold whose space can't be confirmed is abandoned with the text intact", () => {
  // The browser typed nothing, for example because the draft was full.
  const silent = run(drafted("Hi"), {
    type: "spaceDown",
    at: 0,
    selectionStart: 2,
    selectionEnd: 2,
  });
  const abandoned = run(silent, {
    type: "holdTick",
    generation: silent.voice.generation,
    now: 1_000,
  });
  assert.equal(abandoned.voice.phase, "idle");
  assert.equal(abandoned.draft, "Hi");
  // Something other than the hold's own space was typed first.
  const other = run(
    run(drafted("Hi"), {
      type: "spaceDown",
      at: 0,
      selectionStart: 2,
      selectionEnd: 2,
    }),
    { type: "edit", value: "Hi　", caret: 3 },
  );
  assert.equal(other.voice.phase, "idle");
  assert.equal(other.draft, "Hi　");
});

/** A button recording started at a selection and released, awaiting its transcript. */
function transcribing(
  draft: string,
  start: number,
  end = start,
): ComposerState {
  const pressed = run(drafted(draft), {
    type: "buttonDown",
    selectionStart: start,
    selectionEnd: end,
  });
  const { generation } = pressed.voice;
  return run(
    pressed,
    { type: "recordingStarted", generation },
    { type: "released", generation },
  );
}

test("the transcript lands at the saved target despite edits and caret moves while waiting", () => {
  const waiting = transcribing("Hello world", 5);
  const { generation } = waiting.voice;
  const edited = run(
    waiting,
    { type: "edit", value: "Oh, Hello world", caret: 4 },
    { type: "select", start: 15, end: 15 },
    { type: "edit", value: "Oh, Hello world, friends", caret: 24 },
  );
  assert.deepEqual(edited.voice.target, { start: 9, end: 9 });
  const done = run(edited, { type: "transcribed", generation, text: "there" });
  assert.equal(done.draft, "Oh, Hello there world, friends");
  assert.equal(done.voice.phase, "idle");
  assert.equal(done.voice.notice, "inserted");
  assert.equal(done.voice.selection?.start, 15);
});

test("an edit inside the selected text keeps the edit and inserts beside it", () => {
  const waiting = transcribing("Use OLD here", 4, 7);
  const edited = run(waiting, {
    type: "edit",
    value: "Use OLDER here",
    caret: 9,
  });
  const done = run(edited, {
    type: "transcribed",
    generation: waiting.voice.generation,
    text: "new",
  });
  assert.equal(done.draft, "Use OLDER new here");
});

test("results for a sent, cancelled, or superseded dictation are never inserted", () => {
  const waiting = transcribing("Draft", 5);
  const { generation } = waiting.voice;
  // Sending cancels the dictation before the draft clears.
  const sent = run(
    waiting,
    { type: "cancel" },
    { type: "sent", submitted: "Draft" },
    { type: "transcribed", generation, text: "late words" },
  );
  assert.equal(sent.draft, "");
  assert.equal(sent.voice.phase, "idle");
  assert.equal(sent.voice.notice, null);
  const cancelled = run(
    waiting,
    { type: "cancel", notice: "cancelled" },
    {
      type: "transcribed",
      generation,
      text: "late",
    },
  );
  assert.equal(cancelled.draft, "Draft");
  assert.equal(cancelled.voice.notice, "cancelled");
  // A newer dictation ignores the older one's result.
  const newer = run(cancelled, {
    type: "buttonDown",
    selectionStart: 0,
    selectionEnd: 0,
  });
  assert.equal(
    run(newer, { type: "transcribed", generation, text: "late" }),
    newer,
  );
  // A send clears only the draft that was sent.
  assert.equal(
    run(drafted("Draft and more"), { type: "sent", submitted: "Draft" }).draft,
    "Draft and more",
  );
});

test("empty and oversized transcripts change nothing and say why", () => {
  const waiting = transcribing("Draft", 5);
  const { generation } = waiting.voice;
  const empty = run(waiting, { type: "transcribed", generation, text: "  " });
  assert.equal(empty.draft, "Draft");
  assert.equal(empty.voice.notice, "noSpeech");
  const full = transcribing("x".repeat(31_999), 31_999);
  const tooLong = run(full, {
    type: "transcribed",
    generation: full.voice.generation,
    text: "hello",
  });
  assert.equal(tooLong.draft.length, 31_999);
  assert.equal(tooLong.voice.notice, "doesNotFit");
  assert.equal(tooLong.voice.phase, "idle");
});

test("button presses clamp their selection and failures end the dictation with a notice", () => {
  const pressed = run(drafted("Hi"), {
    type: "buttonDown",
    selectionStart: 9,
    selectionEnd: 1,
  });
  assert.deepEqual(pressed.voice.target, { start: 1, end: 2 });
  assert.equal(pressed.voice.source, "button");
  // A second press while one is active is ignored.
  assert.equal(
    run(pressed, { type: "buttonDown", selectionStart: 0, selectionEnd: 0 }),
    pressed,
  );
  const failed = run(pressed, {
    type: "failed",
    generation: pressed.voice.generation,
    notice: "permissionDenied",
  });
  assert.equal(failed.voice.phase, "idle");
  assert.equal(failed.voice.target, null);
  assert.equal(failed.voice.notice, "permissionDenied");
  assert.equal(failed.draft, "Hi");
  assert.equal(run(failed, { type: "dismissNotice" }).voice.notice, null);
});

// ===========================================
// Partial transcripts
// ===========================================

/** A button recording in progress at a selection. */
function recording(draft: string, start: number, end = start): ComposerState {
  const pressed = run(drafted(draft), {
    type: "buttonDown",
    selectionStart: start,
    selectionEnd: end,
  });
  return run(pressed, {
    type: "recordingStarted",
    generation: pressed.voice.generation,
  });
}

/** A partial transcript for the state's dictation. */
function partial(
  state: ComposerState,
  revision: number,
  text: string,
  selection?: { start: number; end: number },
): Extract<ComposerAction, { type: "partial" }> {
  return {
    type: "partial",
    generation: state.voice.generation,
    revision,
    text,
    ...(selection ? { selection } : {}),
  };
}

test("partials revise only the dictation's text, in order, and the final replaces them exactly once", () => {
  const live = recording("Say hello", 3);
  const first = run(live, partial(live, 1, "there"));
  assert.equal(first.draft, "Say there hello");
  assert.deepEqual(first.voice.target, { start: 3, end: 9 });
  const second = run(first, partial(live, 3, " there my "));
  assert.equal(second.draft, "Say there my hello");
  // A revision older than the newest applied is ignored.
  assert.equal(run(second, partial(live, 2, "stale words")), second);
  const released = run(second, {
    type: "released",
    generation: live.voice.generation,
  });
  // Partials keep arriving for audio sent before the release.
  const late = run(released, partial(live, 4, "there my friend"));
  assert.equal(late.draft, "Say there my friend hello");
  const done = run(late, {
    type: "transcribed",
    generation: live.voice.generation,
    text: "there, my friend",
  });
  assert.equal(done.draft, "Say there, my friend hello");
  assert.equal(done.voice.phase, "idle");
  assert.equal(done.voice.live, null);
  assert.equal(done.voice.notice, "inserted");
  assert.deepEqual(
    { start: done.voice.selection?.start, end: done.voice.selection?.end },
    { start: 20, end: 20 },
  );
});

test("a selection stays until the first partial replaces it, and comes back on cancel, failure, or no speech", () => {
  const live = recording("Use OLD here", 4, 7);
  assert.equal(run(live, partial(live, 1, "   ")).draft, "Use OLD here");
  const shown = run(
    live,
    partial(live, 1, "new"),
    partial(live, 2, "newer words"),
  );
  assert.equal(shown.draft, "Use newer words here");
  assert.equal(committedDraft(shown), "Use OLD here");
  assert.equal(
    run(shown, { type: "cancel", notice: "cancelled" }).draft,
    "Use OLD here",
  );
  const failed = run(shown, {
    type: "failed",
    generation: live.voice.generation,
    notice: "unavailable",
  });
  assert.equal(failed.draft, "Use OLD here");
  assert.equal(failed.voice.notice, "unavailable");
  // A blank revision shows the original again.
  assert.equal(run(shown, partial(live, 3, "")).draft, "Use OLD here");
  const released = run(shown, {
    type: "released",
    generation: live.voice.generation,
  });
  const silent = run(released, {
    type: "transcribed",
    generation: live.voice.generation,
    text: " ",
  });
  assert.equal(silent.draft, "Use OLD here");
  assert.equal(silent.voice.notice, "noSpeech");
  // A late partial of the finished dictation changes nothing.
  assert.equal(run(silent, partial(live, 9, "late")), silent);
});

test("typing before or after the partial is kept and moves it; editing the partial itself is refused", () => {
  const live = recording("Hi", 2);
  const shown = run(live, partial(live, 1, "there"));
  assert.equal(shown.draft, "Hi there");
  // Typed right after the partial: the user's, and outside the dictation's text.
  const after = run(shown, { type: "edit", value: "Hi there!", caret: 9 });
  assert.deepEqual(after.voice.target, { start: 2, end: 8 });
  const before = run(after, { type: "edit", value: "Oh Hi there!", caret: 3 });
  assert.deepEqual(before.voice.target, { start: 5, end: 11 });
  const revised = run(before, partial(live, 2, "there friend"));
  assert.equal(revised.draft, "Oh Hi there friend!");
  // Backspace into the partial is refused: the draft stays, and the field is told to show it again.
  const refused = run(revised, {
    type: "edit",
    value: "Oh Hi there frien!",
    caret: 17,
  });
  assert.equal(refused.draft, "Oh Hi there friend!");
  assert.deepEqual(refused.voice.target, revised.voice.target);
  assert.equal(
    refused.voice.selection?.revision,
    (revised.voice.selection?.revision ?? 0) + 1,
  );
  assert.equal(refused.voice.selection?.start, 18);
  const done = run(
    run(refused, { type: "released", generation: live.voice.generation }),
    {
      type: "transcribed",
      generation: live.voice.generation,
      text: "there, friend",
    },
  );
  assert.equal(done.draft, "Oh Hi there, friend!");
});

test("an IME composition is never interrupted; what it typed into the partial is replaced with it", () => {
  const live = recording("Hi", 2);
  const shown = run(live, partial(live, 1, "there"));
  const composed = run(shown, {
    type: "edit",
    value: "Hi thかere",
    caret: 6,
    composing: true,
  });
  assert.equal(composed.draft, "Hi thかere");
  assert.deepEqual(composed.voice.target, { start: 2, end: 9 });
  assert.equal(
    run(composed, partial(live, 2, "there now")).draft,
    "Hi there now",
  );
  // A composition beside the partial is the user's text, like any other typing.
  const beside = run(shown, {
    type: "edit",
    value: "Hi thereか",
    caret: 9,
    composing: true,
  });
  assert.deepEqual(beside.voice.target, { start: 2, end: 8 });
  assert.equal(
    run(beside, partial(live, 2, "there now")).draft,
    "Hi there now か",
  );
});

test("a keystroke made against the draft before a partial was shown is restated, never lost or duplicated", () => {
  const live = recording("Note", 4);
  const shown = run(live, partial(live, 1, "hello"));
  assert.equal(shown.draft, "Note hello");
  // The user typed at the start while the field still showed "Note".
  const early = run(shown, {
    type: "edit",
    value: "A Note",
    caret: 2,
    base: "Note",
  });
  assert.equal(early.draft, "A Note hello");
  assert.deepEqual(early.voice.target, { start: 6, end: 12 });
  // Typed at the end of the old draft, where the partial now is: kept after it.
  const end = run(shown, {
    type: "edit",
    value: "Note!",
    caret: 5,
    base: "Note",
  });
  assert.equal(end.draft, "Note hello!");
  assert.equal(
    run(end, partial(live, 2, "hello you")).draft,
    "Note hello you!",
  );
  // An edit to text the partial replaced conflicts, and the draft keeps the dictation's text.
  const selected = recording("Use OLD here", 4, 7);
  const replaced = run(selected, partial(selected, 1, "new"));
  const conflict = run(replaced, {
    type: "edit",
    value: "Use OL here",
    caret: 6,
    base: "Use OLD here",
  });
  assert.equal(conflict.draft, "Use new here");
});

test("the caret follows the partial when it was there, and otherwise stays where the user left it", () => {
  const live = recording("Hello world", 11);
  const shown = run(live, partial(live, 1, "and", { start: 11, end: 11 }));
  assert.equal(shown.draft, "Hello world and");
  assert.deepEqual(
    { start: shown.voice.selection?.start, end: shown.voice.selection?.end },
    { start: 15, end: 15 },
  );
  const grown = run(
    shown,
    partial(live, 2, "and more", { start: 15, end: 15 }),
  );
  assert.equal(grown.voice.selection?.start, 20);
  // The user put the caret at the start to type there; it stays.
  const elsewhere = run(
    grown,
    partial(live, 3, "and more words", { start: 0, end: 0 }),
  );
  assert.equal(elsewhere.voice.selection?.start, 0);
  // A selection exactly over the original target follows the partial as a caret.
  const selected = recording("Use OLD here", 4, 7);
  const over = run(selected, partial(selected, 1, "new", { start: 4, end: 7 }));
  assert.deepEqual(
    { start: over.voice.selection?.start, end: over.voice.selection?.end },
    { start: 7, end: 7 },
  );
});

test("partials are ignored outside their dictation, and one that won't fit in a message is skipped", () => {
  const live = recording("Draft", 5);
  const { generation } = live.voice;
  assert.equal(
    run(live, { ...partial(live, 1, "words"), generation: generation + 1 }),
    live,
  );
  const cancelled = run(live, { type: "cancel" });
  assert.equal(run(cancelled, partial(live, 1, "late")), cancelled);
  const full = recording("x".repeat(31_990), 31_990);
  const fits = run(full, partial(full, 1, "short"));
  assert.equal(fits.draft.length, 31_996);
  const tooLong = run(fits, partial(full, 2, "much longer than will fit"));
  assert.equal(tooLong.draft, fits.draft);
  assert.equal(tooLong.voice.revision, 2);
  // The final replaces the partial and is measured against the draft without it.
  const done = run(
    run(tooLong, { type: "released", generation: full.voice.generation }),
    { type: "transcribed", generation: full.voice.generation, text: "fits" },
  );
  assert.equal(done.draft, `${"x".repeat(31_990)} fits`);
});

test("a send leaves the partial out of the draft it sends and clears only that", () => {
  const live = recording("Typed", 5);
  const shown = run(live, partial(live, 1, "spoken"));
  const submitted = committedDraft(shown);
  assert.equal(submitted, "Typed");
  const sent = run(shown, { type: "cancel" }, { type: "sent", submitted });
  assert.equal(sent.draft, "");
  assert.equal(committedDraft(drafted("plain")), "plain");
});
