import assert from "node:assert/strict";
import { test } from "node:test";
import {
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

test("a Space hold promotes at exactly 3000 ms, not 2999 ms, restoring the text the space replaced", () => {
  const armed = holdSpace(drafted("Say hello"), 3);
  assert.equal(armed.draft, "Say  hello");
  assert.equal(armed.voice.phase, "arming");
  const { generation } = armed.voice;
  const early = run(armed, { type: "holdTick", generation, now: 3_999 });
  assert.equal(early, armed);
  const promoted = run(armed, { type: "holdTick", generation, now: 4_000 });
  assert.equal(promoted.voice.phase, "starting");
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
    now: 3_000,
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
