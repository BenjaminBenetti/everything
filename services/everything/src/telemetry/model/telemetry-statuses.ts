import {
  modelFailureCategories,
  type ModelFailureCategory,
} from "./model-failure.js";

/**
 * Span status messages Everything writes itself, from a fixed catalog. They hold no provider,
 * library, or user text, so they are exported whether or not the installation records error text.
 */
export const telemetryStatuses = {
  /** A model request that failed, by its category. */
  modelFailed: (category: ModelFailureCategory) =>
    `Model request failed: ${category}`,
  compactionFailed: "Context compaction failed",
  /** A provider's error response, by its HTTP status. */
  httpFailed: (status: number) => `HTTP ${status}`,
} as const;

/** HTTP statuses a response can have. */
const httpStatuses = Array.from({ length: 500 }, (_, index) => 100 + index);

/** Every status message in the catalog, spelled out. */
const fixedStatuses: ReadonlySet<string> = new Set([
  ...modelFailureCategories.map(telemetryStatuses.modelFailed),
  telemetryStatuses.compactionFailed,
  ...httpStatuses.map(telemetryStatuses.httpFailed),
]);

/**
 * Whether `message` is exactly one of Everything's fixed status messages. Text that only looks like
 * one, such as an error message beginning with the same words, is not.
 */
export function isFixedStatus(message: string): boolean {
  return fixedStatuses.has(message);
}
