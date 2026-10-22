import { keyLimits } from "../model/key.js";

/** An unpaired UTF-16 surrogate, which UTF-8 encoding would silently replace. */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Accept any value a process environment can hold exactly: not blank, without a NUL character or
 * an unpaired surrogate, and within the stored size limit in UTF-8 bytes. Values are never trimmed
 * or otherwise rewritten.
 */
export function isGenericCredentialValue(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !value.includes("\0") &&
    !loneSurrogate.test(value) &&
    new TextEncoder().encode(value).length <= keyLimits.materialLength
  );
}
