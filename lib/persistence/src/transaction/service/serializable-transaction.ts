import pRetry from "p-retry";
import { QueryFailedError, type EntityManager } from "typeorm";

/** Retry only serialization failures and deadlocks, which roll back the whole transaction. */
function isRetryableConflict(error: Error): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code } = error.driverError as { code?: string };
  return code === "40001" || code === "40P01";
}

/** Run database-only work atomically; p-retry handles serialization/deadlock backoff. */
export function serializableTransaction<T>(
  manager: EntityManager,
  operation: (transaction: EntityManager) => Promise<T>,
): Promise<T> {
  return pRetry(() => manager.transaction("SERIALIZABLE", operation), {
    retries: 4,
    minTimeout: 10,
    maxTimeout: 100,
    randomize: true,
    /** Never retry connection ambiguity, validation, or application failures. */
    shouldRetry: ({ error }) => isRetryableConflict(error),
  });
}
