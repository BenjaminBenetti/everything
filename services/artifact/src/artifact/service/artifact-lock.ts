import AsyncLock from "async-lock";

/** Serializes changes to one artifact, since this service runs as a single replica. */
export class ArtifactLock {
  // ===========================================
  // State
  // ===========================================

  private readonly lock = new AsyncLock();

  // ===========================================
  // Operations
  // ===========================================

  /** Run one change to an artifact at a time while unrelated artifacts proceed concurrently. */
  run<T>(artifactId: string, operation: () => Promise<T>): Promise<T> {
    return this.lock.acquire(artifactId, operation);
  }
}
