import assert from "node:assert/strict";
import { test } from "node:test";
import {
  scrollToShow,
  shows,
  textThrough,
  type FieldView,
} from "../model/caret-view.js";

/** A field 100px tall with 10px of padding, scrolled to `scrollTop`; its lines are 20px. */
function view(scrollTop: number): FieldView {
  return { scrollTop, height: 100, paddingTop: 10, paddingBottom: 10 };
}

/** The `index`th line of that field's text. */
function line(index: number) {
  return { top: 10 + index * 20, bottom: 30 + index * 20 };
}

test("the text through a position ends with the word that position is in or starts", () => {
  assert.equal(textThrough("one two", 7), "one two");
  assert.equal(textThrough("one two three", 5), "one two");
  assert.equal(textThrough("one two three", 4), "one two");
  assert.equal(textThrough("one two three", 3), "one");
  assert.equal(textThrough("one\ntwo", 4), "one\ntwo");
  assert.equal(textThrough("one\ntwo", 3), "one");
  assert.equal(textThrough("one\n", 4), "one\n");
  assert.equal(textThrough("", 0), "");
});

test("a field shows a line when at least half of it is inside its visible area", () => {
  // Visible from 40 to 140: line 1 (30–50) is half inside, line 0 (10–30) is out.
  assert.equal(shows(view(40), line(1)), true);
  assert.equal(shows(view(41), line(1)), false);
  assert.equal(shows(view(40), line(0)), false);
  assert.equal(shows(view(40), line(4)), true);
  // Line 6 (130–150) has 10px inside, half of it.
  assert.equal(shows(view(40), line(6)), true);
  assert.equal(shows(view(39), line(6)), false);
  assert.equal(shows(view(40), line(9)), false);
});

test("a line below the visible area is brought to the bottom edge with the field's padding", () => {
  // Line 6 ends at 150; with 10px of padding below it, the field shows 60–160.
  assert.equal(scrollToShow(view(0), line(6)), 60);
  assert.equal(scrollToShow(view(40), line(6)), 60);
});

test("a line above the visible area is brought to the top edge with the field's padding", () => {
  assert.equal(scrollToShow(view(120), line(2)), 40);
  assert.equal(scrollToShow(view(120), line(0)), 0);
});

test("a line already shown whole leaves the field where it is, even with its padding out of view", () => {
  assert.equal(scrollToShow(view(40), line(2)), 40);
  assert.equal(scrollToShow(view(40), line(5)), 40);
  assert.equal(scrollToShow(view(0), line(0)), 0);
  assert.equal(scrollToShow(view(2), line(0)), 2);
  assert.equal(scrollToShow(view(45), line(4)), 45);
});

test("a line a rounding pixel past an edge counts as shown", () => {
  // Line 0 is 10–30 and line 5 is 110–130.
  assert.equal(scrollToShow(view(11), line(0)), 11);
  assert.equal(scrollToShow(view(29), line(5)), 29);
  assert.equal(scrollToShow(view(12), line(0)), 0);
  assert.equal(scrollToShow(view(28), line(5)), 40);
});

test("a field too short for a line and its padding shows the line's top", () => {
  const short: FieldView = {
    scrollTop: 0,
    height: 30,
    paddingTop: 10,
    paddingBottom: 10,
  };
  assert.equal(scrollToShow(short, line(3)), 60);
});
