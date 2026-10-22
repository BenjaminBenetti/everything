import { keyLimits } from "../model/key.js";

/**
 * Accept any value a process environment can hold exactly: not blank, without a NUL character, and
 * within the stored size limit in UTF-8 bytes. Values are never trimmed or otherwise rewritten.
 */
export function isGenericCredentialValue(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).length <= keyLimits.materialLength
  );
}
