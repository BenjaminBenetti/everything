import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JobField } from "../component/job-field.js";

/** Render a field with a textarea control, as the job editor's Instructions field does. */
function render(description?: string): string {
  return renderToStaticMarkup(
    createElement(JobField, {
      label: "Instructions",
      ...(description ? { description } : {}),
      children: ({ id, describedBy }) =>
        createElement("textarea", { id, "aria-describedby": describedBy }),
    }),
  );
}

test("a field's label holds only its name; help text is a separate description the control references", () => {
  const html = render("Each run starts fresh.");
  const id = /<label for="([^"]+)">/.exec(html)?.[1];
  assert.ok(id, "the label points at the control");
  // The label's whole content is the name, so the accessible name is exactly "Instructions".
  assert.equal(
    html,
    `<div class="field"><label for="${id}">Instructions</label>` +
      `<textarea id="${id}" aria-describedby="${id}-description"></textarea>` +
      `<small id="${id}-description">Each run starts fresh.</small></div>`,
  );
});

test("a field without help text has no description reference", () => {
  const html = render();
  const id = /<label for="([^"]+)">/.exec(html)?.[1];
  assert.equal(
    html,
    `<div class="field"><label for="${id}">Instructions</label><textarea id="${id}"></textarea></div>`,
  );
});
