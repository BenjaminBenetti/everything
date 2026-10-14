/** Produce a bounded extract from the delivered content without model calls or invented claims. */
export function summarizeMessage(markdown: string): string {
  const plain = markdown
    .replace(/^\s*```[^\n]*\n/gm, "")
    .replace(/^\s*```\s*$/gm, "")
    .replace(/!?(\[([^\]]*)\])\([^\n)]*\)/g, "$2")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/^\s*[-|:]{3,}\s*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= 280) return plain || markdown.trim().slice(0, 280);
  const prefix = plain.slice(0, 279);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > 200 ? boundary : 279).trimEnd()}…`;
}
