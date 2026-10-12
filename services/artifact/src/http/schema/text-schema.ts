import { Type } from "typebox";

/** Required text with at least one non-whitespace character and at most `maxLength` characters. */
export function nonBlankText(maxLength: number) {
  return Type.String({ minLength: 1, maxLength, pattern: "\\S" });
}
