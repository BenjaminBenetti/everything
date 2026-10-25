import { telemetryLimits } from "@everything/telemetry-contracts";
import { redactStart, truncationMarker } from "./telemetry-redactor.js";
import { fitUtf8, utf8Length, type FittedText } from "./text-budget.js";

/** What an inline literal is shown as; bound parameters are `$1`, `$2`, … and never recorded. */
export const sqlLiteralPlaceholder = "?";

/** Most characters of a statement read, so the time taken is bounded however long it is. */
const scanLimit = 8_192;

/**
 * Characters that can continue an identifier or keyword, so a quote after one isn't a prefix and a
 * dollar after one isn't a dollar quote. PostgreSQL counts every non-ASCII character as a letter.
 */
const identifierCharacter = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/** Characters a dollar-quote tag can start with, as PostgreSQL's lexer defines them. */
const tagStart = /[A-Za-z_\u0080-\uFFFF]/;

/** Characters a dollar-quote tag can continue with. */
const tagCharacter = /[A-Za-z0-9_\u0080-\uFFFF]/;

/**
 * An SQL statement's shape for a span: keywords, identifiers, and `$n` parameter placeholders
 * stay; string, numeric, and dollar-quoted literals become `?` and comments are dropped, so values
 * written into the statement itself, such as a password or a connection string, are never kept.
 * Dollar-quote tags follow PostgreSQL's rules, non-ASCII letters and any length included. Parameter
 * values are never part of the text. Quoted identifiers are redacted for credentials, `name=value`
 * included, as the names they spell once SQL's doubled quotes are undone; whitespace runs become
 * one space; what remains is redacted for credential shapes; and the result fits
 * `telemetryLimits.previewBytes` of UTF-8, marked when cut. A literal, comment, or dollar-quote
 * opener the statement doesn't close hides the rest of it. The statement that runs is unchanged;
 * only this copy is recorded.
 */
export function sqlStatementPreview(
  statement: string,
  options: {
    /** The statement may already have been cut before it got here, such as by an attribute limit. */
    readonly cut?: boolean;
    readonly budget?: number;
  } = {},
): FittedText {
  const budget = options.budget ?? telemetryLimits.previewBytes;
  const scanned = statement.length > scanLimit;
  const shape = sqlShape(scanned ? statement.slice(0, scanLimit) : statement);
  // Every value is a placeholder now, so only credential shapes, such as a key used as a name, remain.
  const { text, cut } = redactStart(shape.text, budget * 2 + 512, {
    assignments: false,
  });
  const trimmed = text.trim();
  if (!(options.cut || scanned || cut || shape.unterminated))
    return fitUtf8(trimmed, budget, truncationMarker);
  const head = fitUtf8(trimmed, budget - utf8Length(truncationMarker), "");
  return { text: head.text + truncationMarker, truncated: true };
}

/** A statement with its literals and comments replaced, and whether one ran to its end. */
function sqlShape(statement: string): { text: string; unterminated: boolean } {
  let result = "";
  let index = 0;
  while (index < statement.length) {
    const character = statement[index]!;
    const next = statement[index + 1];
    if (character === "-" && next === "-") {
      const end = statement.indexOf("\n", index + 2);
      if (end < 0) return { text: result, unterminated: false };
      if (!result.endsWith(" ")) result += " ";
      index = end + 1;
    } else if (character === "/" && next === "*") {
      const end = blockCommentEnd(statement, index);
      if (end < 0) return { text: result, unterminated: true };
      if (!result.endsWith(" ")) result += " ";
      index = end;
    } else if (character === "'") {
      // A literal's prefix, such as E for backslash escapes, is part of it.
      const prefix =
        /[EeBbXxNn]$/.test(result) &&
        !identifierCharacter.test(result.at(-2) ?? "")
          ? result.at(-1)!
          : "";
      if (prefix) result = result.slice(0, -1);
      const end = quotedEnd(statement, index, /[Ee]/.test(prefix));
      result += sqlLiteralPlaceholder;
      if (end < 0) return { text: result, unterminated: true };
      index = end;
    } else if (character === '"') {
      const end = quotedEnd(statement, index, false, '"');
      if (end < 0)
        return { text: result + sqlLiteralPlaceholder, unterminated: true };
      // A name stays, but credentials written into it, such as `password=…`, don't. Its doubled
      // quotes are undone first, so a quoted value reads as one, and redone after.
      const name = statement.slice(index + 1, end - 1).replaceAll('""', '"');
      result += `"${redactStart(name, end).text.replaceAll('"', '""')}"`;
      index = end;
    } else if (
      character === "$" &&
      !identifierCharacter.test(result.at(-1) ?? "") &&
      (next === "$" || tagStart.test(next ?? ""))
    ) {
      const tag = dollarQuoteTag(statement, index);
      // An opener whose tag doesn't close, or a quote that doesn't, hides the rest of the text.
      const end = tag ? statement.indexOf(tag, index + tag.length) : -1;
      result += sqlLiteralPlaceholder;
      if (end < 0) return { text: result, unterminated: true };
      index = end + tag!.length;
    } else if (
      /[0-9]/.test(character) &&
      !identifierCharacter.test(result.at(-1) ?? "")
    ) {
      // A number written into the statement, such as 42, 3.5, 1e-3, or 0x1F, is a value too.
      index = numberEnd(statement, index);
      result += sqlLiteralPlaceholder;
    } else if (/\s/.test(character)) {
      if (!result.endsWith(" ")) result += " ";
      index++;
    } else {
      result += character;
      index++;
    }
  }
  return { text: result, unterminated: false };
}

/**
 * The dollar-quote tag opening at `start`, such as `$$`, `$body$`, or `$ü$`, or undefined when its
 * tag never reaches a closing dollar, which PostgreSQL would reject. Tags may be any length.
 */
function dollarQuoteTag(statement: string, start: number): string | undefined {
  let index = start + 1;
  while (index < statement.length && tagCharacter.test(statement[index]!))
    index++;
  return statement[index] === "$"
    ? statement.slice(start, index + 1)
    : undefined;
}

/** The index after a numeric literal starting at `start`, with its fraction and exponent. */
function numberEnd(statement: string, start: number): number {
  let index = start + 1;
  while (index < statement.length) {
    const character = statement[index]!;
    if (/[0-9A-Za-z_]/.test(character)) index++;
    else if (character === "." && /[0-9]/.test(statement[index + 1] ?? ""))
      index++;
    else if (/[+-]/.test(character) && /[Ee]/.test(statement[index - 1]!))
      index++;
    else break;
  }
  return index;
}

/**
 * The index after a quoted literal or identifier opening at `start`, or -1 if it is never closed.
 * A doubled quote stays inside it, and so, with `backslashes`, does an escaped one.
 */
function quotedEnd(
  statement: string,
  start: number,
  backslashes: boolean,
  quote = "'",
): number {
  for (let index = start + 1; index < statement.length; index++) {
    const character = statement[index];
    if (backslashes && character === "\\") index++;
    else if (character === quote) {
      if (statement[index + 1] !== quote) return index + 1;
      index++;
    }
  }
  return -1;
}

/** The index after a block comment opening at `start`, which PostgreSQL lets nest, or -1. */
function blockCommentEnd(statement: string, start: number): number {
  let depth = 0;
  for (let index = start; index < statement.length - 1; index++) {
    if (statement[index] === "/" && statement[index + 1] === "*") {
      depth++;
      index++;
    } else if (statement[index] === "*" && statement[index + 1] === "/") {
      depth--;
      index++;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}
