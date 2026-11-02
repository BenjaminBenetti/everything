import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "../component/message-markdown.js";
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
/** Exercise the production Markdown parser/components, not a parallel regex renderer. */
const render = (text: string, agentId: string | undefined = first) =>
  renderToStaticMarkup(createElement(MessageMarkdown, { text, agentId }));

test("only image AST nodes resolve root-relative/absolute paths with this conversation's identity", () => {
  const text = `![Chart](plots/chart.png) ![Absolute](</workspace/${first}/plots/Quarterly chart α.png>)`;
  const html = render(text);
  assert.equal((html.match(/<img /g) ?? []).length, 2);
  assert.ok(
    html.includes(`/v1/agents/${first}/workspace-image?path=plots%2Fchart.png`),
  );
  assert.match(html, /Quarterly\+chart\+%CE%B1.png/);
  const switched = render(text, second);
  assert.ok(
    switched.includes(
      `/v1/agents/${second}/workspace-image?path=plots%2Fchart.png`,
    ),
  );
  assert.ok(!switched.includes(`/v1/agents/${first}/workspace-image`));
  assert.ok(switched.includes("Absolute (image unavailable)"));
  assert.ok(
    !renderToStaticMarkup(
      createElement(MessageMarkdown, { text: "![Chart](plots/chart.png)" }),
    ).includes("<img"),
  );
});

test("plain paths, links, code and raw HTML never become workspace images", () => {
  const html = render(
    'plots/plain.png\n\n[Download](plots/link.png)\n\n`![Inline](plots/code.png)`\n\n```md\n![Fence](plots/fence.png)\n```\n\n<img src="plots/html.png">',
  );
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("workspace-image"));
  assert.ok(html.includes('href="plots/link.png"'));
  assert.ok(html.includes("&lt;img"));
});

test("nested/escaped image filenames work while HTTP images, app content, footnotes and safe URL defaults survive", () => {
  const html = render(
    "> **Chart** ![Nested](plots/a\\(b\\).png)\n\n![Web](https://example.test/image.png) ![App](/v1/agents/one/attachments/two/content)\n\n[Link](https://example.test) A note[^x].\n\n[^x]: Footnote",
  );
  assert.match(html, /path=plots%2Fa%28b%29.png/);
  assert.ok(html.includes('src="https://example.test/image.png"'));
  assert.ok(html.includes('src="/v1/agents/one/attachments/two/content"'));
  assert.ok(html.includes("Footnote"));
  assert.ok(html.includes('referrerPolicy="no-referrer"'));
  assert.ok(html.includes('loading="lazy"'));
  for (const source of [
    "javascript:alert(1)",
    "data:image/png;base64,AA",
    "file:///workspace/private.png",
    "../secret.png",
    `/workspace/${second}/plot.png`,
  ])
    assert.ok(!render(`![Bad](${source})`).includes("<img"), source);
});
