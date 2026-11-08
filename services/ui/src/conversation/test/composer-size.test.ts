import assert from "node:assert/strict";
import { test } from "node:test";
import { fitToContent } from "../hook/use-composer-size.js";

/**
 * A field in a container, laid out like the composer: the field is at least its CSS minimum, the
 * container is the field plus its own padding and controls, and reading the field's scrollHeight
 * lays both out, as browsers do. Each layout's container height is recorded.
 */
function composer({
  content,
  height,
  minHeight = "",
}: {
  content: number;
  height: number;
  minHeight?: string;
}) {
  const fieldMinimum = 72;
  const chrome = 64;
  const layouts: number[] = [];
  const fieldHeight = () =>
    Math.max(fieldMinimum, Number.parseFloat(field.style.height) || 0);
  const containerHeight = () =>
    Math.max(
      Number.parseFloat(container.style.minHeight) || 0,
      fieldHeight() + chrome,
    );
  const container = {
    style: { minHeight },
    getBoundingClientRect: () => ({ height: containerHeight() }),
  };
  const field = {
    style: { height: `${height}px` },
    parentElement: container,
    get scrollHeight() {
      layouts.push(containerHeight());
      return Math.max(content, fieldHeight());
    },
  };
  return { field, container, layouts, containerHeight };
}

test("measuring a draft of unchanged height never shrinks the composer, so the conversation above keeps its size", () => {
  const { field, container, layouts, containerHeight } = composer({
    content: 138,
    height: 138,
  });
  fitToContent(field);
  assert.deepEqual(layouts, [202]);
  assert.equal(field.style.height, "138px");
  assert.equal(container.style.minHeight, "");
  assert.equal(containerHeight(), 202);
});

test("a longer draft grows the field to its content", () => {
  const { field, layouts, containerHeight } = composer({
    content: 200,
    height: 138,
  });
  fitToContent(field);
  assert.deepEqual(layouts, [202]);
  assert.equal(field.style.height, "200px");
  assert.equal(containerHeight(), 264);
});

test("a shorter draft shrinks the field once the measurement is done", () => {
  const { field, container, layouts, containerHeight } = composer({
    content: 40,
    height: 138,
  });
  fitToContent(field);
  assert.deepEqual(layouts, [202]);
  assert.equal(field.style.height, "72px");
  assert.equal(container.style.minHeight, "");
  assert.equal(containerHeight(), 136);
});

test("the container's own minimum height is restored", () => {
  const { field, container } = composer({
    content: 90,
    height: 90,
    minHeight: "180px",
  });
  fitToContent(field);
  assert.equal(field.style.height, "90px");
  assert.equal(container.style.minHeight, "180px");
});

test("a field without a container is still fitted", () => {
  const field = {
    style: { height: "120px" },
    parentElement: null,
    scrollHeight: 96,
  };
  fitToContent(field);
  assert.equal(field.style.height, "96px");
});
