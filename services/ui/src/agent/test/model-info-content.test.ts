import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EffectiveModel } from "@everything/provider-contracts/inference";
import { ModelInfoContent } from "../component/model-info-content.js";

const fallback: EffectiveModel = {
  provider: "chatgpt",
  model: "gpt-6.1-terra",
  contextWindow: 200000,
  contextSource: "fallback",
  imageInput: true,
  imageSource: "documentation",
};
const render = (props: Parameters<typeof ModelInfoContent>[0]) =>
  renderToStaticMarkup(createElement(ModelInfoContent, props));

test("context UI renders the backend budget, independent context/image sources and the docs caveat", () => {
  const html = render({
    info: { selected: fallback, applied: fallback, selectionError: false },
  });
  for (const text of [
    "200,000 tokens",
    "Fallback (default)",
    "Assumed planning budget",
    "Documentation fallback",
    "not API-detected",
    "Applied to loaded runtime",
    "Saving identical settings does not refresh",
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes("1,050,000"));
  assert.ok(!html.includes("next runtime"));
});

test("context UI keeps current selection and the loaded budget distinct when either identity or metadata changes", () => {
  const selected = {
    ...fallback,
    model: "new-model",
    contextWindow: 8192,
    contextSource: "provider" as const,
    imageInput: false,
    imageSource: "provider" as const,
  };
  const html = render({
    info: { selected, applied: fallback, selectionError: false },
  });
  for (const text of [
    "200,000 tokens",
    "8,192 tokens",
    "Provider detected",
    "Selected model · next runtime",
    "new-model",
    "Unsupported",
  ])
    assert.ok(html.includes(text), text);
  const catalog = render({
    info: {
      selected: { ...selected, contextSource: "catalog" },
      applied: null,
      selectionError: false,
    },
  });
  assert.ok(catalog.includes("Catalog estimate"));
  assert.ok(catalog.includes("No runtime loaded"));
  const sameIdentity = render({
    info: {
      selected: { ...fallback, contextWindow: 8192, contextSource: "provider" },
      applied: fallback,
      selectionError: false,
    },
  });
  assert.ok(sameIdentity.includes("Selected model · next runtime"));
});

test("context UI distinguishes unconfirmed, loading, transport errors and discovery failures", () => {
  assert.ok(render({ pending: true }).includes("Loading model details"));
  assert.ok(render({ error: true }).includes("couldn’t load"));
  assert.ok(
    render({
      info: { selected: null, applied: null, selectionError: false },
    }).includes("No model selected"),
  );
  const html = render({
    info: { selected: null, applied: fallback, selectionError: true },
  });
  assert.ok(html.includes("200,000 tokens"));
  assert.ok(html.includes("Selected model details are unavailable"));
  const unknown = render({
    info: {
      selected: { ...fallback, imageInput: null, imageSource: "unknown" },
      applied: null,
      selectionError: false,
    },
  });
  assert.ok(unknown.includes("Unconfirmed · Unknown"));
});
