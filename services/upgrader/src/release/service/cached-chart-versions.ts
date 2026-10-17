import type { ChartVersions } from "../interface/chart-versions.js";

/** A listing and the time it stops being reused. */
interface CachedListing {
  readonly versions: string[];
  readonly expiresAt: number;
}

/**
 * Reuses the published versions for a while, so status checks, which the UI repeats while an
 * upgrade runs, stay off the registry; starting an upgrade asks for a fresh listing.
 */
export class CachedChartVersions implements ChartVersions {
  // ===========================================
  // State and construction
  // ===========================================

  private cached: CachedListing | undefined;
  private pending: Promise<string[]> | undefined;

  /** Wrap a registry; the clock is replaceable for tests. */
  constructor(
    private readonly registry: ChartVersions,
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Return the cached listing while it is fresh, sharing one request among concurrent callers. */
  async published(options?: { readonly fresh?: boolean }): Promise<string[]> {
    if (!options?.fresh && this.cached && this.cached.expiresAt > this.now())
      return this.cached.versions;
    this.pending ??= this.registry
      .published()
      .then((versions) => {
        this.cached = { versions, expiresAt: this.now() + this.maxAgeMs };
        return versions;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
