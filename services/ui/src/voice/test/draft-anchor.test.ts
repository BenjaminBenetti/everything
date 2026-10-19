import assert from "node:assert/strict";
import { test } from "node:test";
import {
  absorbEdit,
  draftEdit,
  followSelection,
  insertTranscript,
  mapOwned,
  mapSpan,
  rebaseEdit,
  writeExact,
  writeSpaced,
  type DraftSpan,
} from "../model/draft-anchor.js";

/** Map a span through the edit between two drafts. */
function follow(
  span: DraftSpan,
  before: string,
  after: string,
  caret?: number,
): DraftSpan {
  const edit = draftEdit(before, after, caret);
  assert.ok(edit);
  return mapSpan(span, edit);
}

test("finds the single edit, using the caret to place ambiguous changes", () => {
  assert.equal(draftEdit("same", "same"), null);
  assert.deepEqual(draftEdit("hello", "hello ", 6), {
    start: 5,
    removed: 0,
    inserted: 1,
  });
  // Typing "a" at the start of "aa" leaves the caret at 1, so the insertion was at 0.
  assert.deepEqual(draftEdit("aa", "aaa", 1), {
    start: 0,
    removed: 0,
    inserted: 1,
  });
  assert.deepEqual(draftEdit("aa", "aaa", 3), {
    start: 2,
    removed: 0,
    inserted: 1,
  });
  // Backspace in "aaa" leaving the caret at 1 removed the second character.
  assert.deepEqual(draftEdit("aaa", "aa", 1), {
    start: 1,
    removed: 1,
    inserted: 0,
  });
  assert.deepEqual(draftEdit("abcd", "aXd", 2), {
    start: 1,
    removed: 2,
    inserted: 1,
  });
  assert.deepEqual(draftEdit("abc", "", 0), {
    start: 0,
    removed: 3,
    inserted: 0,
  });
});

test("a target keeps its place through edits before, after, and beside it", () => {
  const target = { start: 6, end: 11 }; // "world" in "hello world!"
  const draft = "hello world!";
  assert.deepEqual(follow(target, draft, "oh, hello world!", 4), {
    start: 10,
    end: 15,
  });
  assert.deepEqual(follow(target, draft, "hello world!!!", 14), target);
  assert.deepEqual(follow(target, draft, "hi world!", 2), { start: 3, end: 8 });
  assert.deepEqual(follow(target, draft, "hello world! Bye", 16), target);
});

test("typing against either end of a selected target keeps the typing and inserts after it", () => {
  const target = { start: 6, end: 11 }; // "world" in "hello world!"
  const draft = "hello world!";
  // "world" became "worldly": the transcript goes after the changed word instead of replacing it.
  assert.deepEqual(follow(target, draft, "hello worldly!", 13), {
    start: 13,
    end: 13,
  });
  assert.deepEqual(follow(target, draft, "hello Xworld!", 7), {
    start: 12,
    end: 12,
  });
});

test("words typed at a position target stay after the transcript", () => {
  const point = { start: 5, end: 5 };
  assert.deepEqual(follow(point, "hello", "hello there", 11), point);
  assert.deepEqual(follow(point, "hello", "oh hello", 3), { start: 8, end: 8 });
});

test("an edit touching the target's text collapses it after the edit, deleting nothing new", () => {
  const draft = "hello world!";
  const target = { start: 6, end: 11 };
  // Retyping inside the selected words.
  assert.deepEqual(follow(target, draft, "hello wXorld!", 8), {
    start: 12,
    end: 12,
  });
  // Replacing the selection and more.
  assert.deepEqual(follow(target, draft, "hello there", 11), {
    start: 11,
    end: 11,
  });
  // Clearing the draft entirely.
  assert.deepEqual(follow(target, draft, "", 0), { start: 0, end: 0 });
  const inserted = insertTranscript(
    "hello wXorld!",
    { start: 12, end: 12 },
    "planet",
    100,
  );
  assert.deepEqual(inserted, { draft: "hello wXorld planet!", caret: 19 });
});

test("inserts the trimmed transcript with spacing, replacing the target", () => {
  assert.deepEqual(
    insertTranscript("", { start: 0, end: 0 }, "  Hi there. ", 100),
    {
      draft: "Hi there.",
      caret: 9,
    },
  );
  assert.deepEqual(
    insertTranscript("Say", { start: 3, end: 3 }, "hello", 100),
    {
      draft: "Say hello",
      caret: 9,
    },
  );
  assert.deepEqual(
    insertTranscript("Say now", { start: 4, end: 4 }, "hello", 100),
    {
      draft: "Say hello now",
      caret: 9,
    },
  );
  assert.deepEqual(insertTranscript("(", { start: 1, end: 1 }, "note", 100), {
    draft: "(note",
    caret: 5,
  });
  assert.deepEqual(
    insertTranscript("Use OLD here", { start: 4, end: 7 }, "new", 100),
    {
      draft: "Use new here",
      caret: 7,
    },
  );
  assert.deepEqual(
    insertTranscript("End", { start: 3, end: 3 }, "words.", 100),
    {
      draft: "End words.",
      caret: 10,
    },
  );
});

test("never cuts a transcript to fit, and reports empty transcripts", () => {
  assert.deepEqual(insertTranscript("abc", { start: 3, end: 3 }, "   ", 100), {
    error: "empty",
  });
  assert.deepEqual(
    insertTranscript("x".repeat(95), { start: 95, end: 95 }, "hello", 100),
    {
      error: "capacity",
    },
  );
  assert.deepEqual(
    insertTranscript("x".repeat(94), { start: 94, end: 94 }, "hello", 100),
    {
      draft: `${"x".repeat(94)} hello`,
      caret: 100,
    },
  );
  // Replacing a selection frees its length.
  assert.deepEqual(
    insertTranscript("x".repeat(100), { start: 0, end: 100 }, "hello", 100),
    { draft: "hello", caret: 5 },
  );
});

// ===========================================
// Live dictation text
// ===========================================

test("spaced writes cover their own spaces, so rewriting them never adds another", () => {
  const first = writeSpaced("Hello world", { start: 5, end: 5 }, "big");
  assert.deepEqual(first, {
    draft: "Hello big world",
    span: { start: 5, end: 9 },
    textEnd: 9,
  });
  const mid = writeSpaced("Helloworld", { start: 5, end: 5 }, "big");
  assert.deepEqual(mid, {
    draft: "Hello big world",
    span: { start: 5, end: 10 },
    textEnd: 9,
  });
  const again = writeSpaced(mid.draft, mid.span, "bigger");
  assert.equal(again.draft, "Hello bigger world");
  assert.equal(writeExact(again.draft, again.span, "").draft, "Helloworld");
});

test("owned text moves with edits beside it, keeps typing at either end outside, and refuses edits to itself", () => {
  const span = { start: 3, end: 8 };
  // Typing at the end or the start stays outside; elsewhere moves or leaves it.
  assert.deepEqual(mapOwned(span, { start: 8, removed: 0, inserted: 1 }), span);
  assert.deepEqual(mapOwned(span, { start: 3, removed: 0, inserted: 2 }), {
    start: 5,
    end: 10,
  });
  assert.deepEqual(mapOwned(span, { start: 0, removed: 3, inserted: 0 }), {
    start: 0,
    end: 5,
  });
  assert.deepEqual(mapOwned(span, { start: 9, removed: 4, inserted: 1 }), span);
  // Backspace at its end, typing inside, or a selection across it changes it.
  for (const edit of [
    { start: 7, removed: 1, inserted: 0 },
    { start: 5, removed: 0, inserted: 1 },
    { start: 1, removed: 4, inserted: 1 },
  ])
    assert.equal(mapOwned(span, edit), null, JSON.stringify(edit));
  // An edit it must take in grows it to cover what was typed.
  assert.deepEqual(absorbEdit(span, { start: 5, removed: 1, inserted: 2 }), {
    start: 3,
    end: 9,
  });
  // Removing 1-5 and typing one character leaves the owned 5-8 at 2-5, after what was typed.
  assert.deepEqual(absorbEdit(span, { start: 1, removed: 4, inserted: 1 }), {
    start: 1,
    end: 5,
  });
});

test("a selection follows rewritten text only when it was at it", () => {
  const from = { start: 4, end: 9 };
  const to = { start: 4, end: 14 };
  assert.deepEqual(followSelection(undefined, from, to, 14), {
    start: 14,
    end: 14,
  });
  assert.deepEqual(followSelection({ start: 9, end: 9 }, from, to, 14), {
    start: 14,
    end: 14,
  });
  assert.deepEqual(followSelection({ start: 6, end: 6 }, from, to, 14), {
    start: 14,
    end: 14,
  });
  assert.deepEqual(followSelection({ start: 4, end: 9 }, from, to, 14), {
    start: 14,
    end: 14,
  });
  assert.deepEqual(followSelection({ start: 4, end: 4 }, from, to, 14), {
    start: 4,
    end: 4,
  });
  assert.deepEqual(followSelection({ start: 1, end: 2 }, from, to, 14), {
    start: 1,
    end: 2,
  });
  assert.deepEqual(followSelection({ start: 10, end: 12 }, from, to, 14), {
    start: 15,
    end: 17,
  });
  // An empty target: a caret at it follows.
  const point = { start: 4, end: 4 };
  assert.deepEqual(
    followSelection({ start: 4, end: 4 }, point, { start: 4, end: 8 }, 8),
    { start: 8, end: 8 },
  );
});

test("an edit to an older draft is restated past the dictation's change, unless both changed the same text", () => {
  // The dictation wrote " hi" at 5 since the user's keystroke was made.
  assert.deepEqual(rebaseEdit("Hello", "Hello!", 6, "Hello hi"), {
    value: "Hello hi!",
    caret: 9,
  });
  assert.deepEqual(rebaseEdit("Hello", "Oh Hello", 3, "Hello hi"), {
    value: "Oh Hello hi",
    caret: 3,
  });
  // The dictation replaced "OLD"; the user deleted from it.
  assert.equal(
    rebaseEdit("Use OLD here", "Use OL here", 6, "Use new here"),
    null,
  );
});
