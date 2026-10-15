import { updateSummaryMaxLength } from "@everything/update-contracts";

/** Normalize whitespace and clamp to the summary limit on a word boundary, marking any cut with an ellipsis. */
export function clampSummary(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length <= updateSummaryMaxLength) return plain;
  const room = plain.slice(0, updateSummaryMaxLength - 1);
  const boundary =
    plain[room.length] === " " ? room.length : room.lastIndexOf(" ");
  const cut =
    boundary >= updateSummaryMaxLength / 2
      ? room.slice(0, boundary)
      : room.replace(/[\uD800-\uDBFF]$/, "");
  return `${cut.replace(/[\s,;:–—-]+$/, "")}…`;
}

/** Drop quotation marks a model wrapped around its whole answer, leaving inner quotes intact. */
export function unwrapQuotes(text: string): string {
  const trimmed = text.trim();
  return /^["“][^"“”]*["”]$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}
