import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** Longest notification body, which fits two or three lines in desktop notification centers. */
export const notificationPreviewMaxLength = 140;

/** A preview needs only the beginning of a long message; parsing stops here. */
const parsedTextMaxLength = 4_000;

/** Containers whose children are separate blocks, joined with a space instead of run together. */
const blockContainers = new Set<Nodes["type"]>([
  "root",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "footnoteDefinition",
]);

/** Control characters and bidirectional overrides, which could rearrange how a preview reads. */
const unsafeCharacters =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Read what a Markdown node displays, dropping raw HTML and keeping link text and image descriptions. */
function displayedText(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value;
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "break":
    case "thematicBreak":
      return " ";
    case "html":
    case "definition":
    case "footnoteReference":
    case "yaml":
      return "";
    default:
      return "children" in node
        ? node.children
            .map((child) => displayedText(child))
            .join(blockContainers.has(node.type) ? " " : "")
        : "";
  }
}

/** Shorten on a word boundary when one is reasonably close, marking the cut with an ellipsis. */
function clamp(text: string): string {
  if (text.length <= notificationPreviewMaxLength) return text;
  const room = text.slice(0, notificationPreviewMaxLength - 1);
  const boundary =
    text[room.length] === " " ? room.length : room.lastIndexOf(" ");
  const cut =
    boundary >= notificationPreviewMaxLength / 2
      ? room.slice(0, boundary)
      : room.replace(/[\uD800-\uDBFF]$/, "");
  return `${cut.replace(/[\s,;:–—-]+$/, "")}…`;
}

/**
 * Turn delivered message text into a short plain-text preview: Markdown syntax and HTML tags are
 * removed, whitespace collapses, and the result is clamped. Returns "" when nothing readable remains.
 */
export function notificationPreview(text: string): string {
  const tree = fromMarkdown(text.slice(0, parsedTextMaxLength), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return clamp(
    displayedText(tree)
      .replace(unsafeCharacters, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}
