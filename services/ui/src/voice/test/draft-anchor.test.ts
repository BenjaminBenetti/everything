import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftEdit,
  insertTranscript,
  mapSpan,
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
