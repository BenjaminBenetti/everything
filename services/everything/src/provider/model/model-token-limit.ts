/** Largest accepted provider or catalog token count, bounding malformed capability metadata. */
const maximumTokens = 100_000_000;

/** Treat absent, malformed, and unbounded token limits as unknown at discovery and resolution. */
export function modelTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= maximumTokens
    ? value
    : undefined;
}
