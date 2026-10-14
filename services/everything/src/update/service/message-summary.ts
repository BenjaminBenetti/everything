import { summaryMaxLength } from "../model/message-summary.js";

/** Bound model output or a clearly labeled fallback without changing code or identifiers. */
export function messagePreview(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length <= summaryMaxLength) return plain;
  const prefix = plain.slice(0, summaryMaxLength - 1);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > 200 ? boundary : summaryMaxLength - 1).trimEnd()}…`;
}
