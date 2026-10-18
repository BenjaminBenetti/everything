/** Something delivered at a server time, such as an update or a conversation message. */
export interface Delivery {
  readonly id: string;
  readonly createdAt: string;
}

/** IDs remembered against repeats; the high-water mark, not this list, keeps older rows out. */
const rememberedIdsMax = 500;

/**
 * Tell new deliveries from ones already observed, using the newest delivery time seen so far.
 * The first observation is the baseline, so nothing that existed before it counts as new. After
 * that, an item is new only when it was delivered after the newest one seen, or at that same
 * instant without having been seen. Older rows that resurface, such as unread updates moving onto
 * the first page after newer ones are read, never count as new, and repeating an observation after
 * a reconnect finds nothing.
 */
export class DeliveryHighWater {
  // ===========================================
  // Observed deliveries
  // ===========================================
  private baselined = false;
  private newest = Number.NEGATIVE_INFINITY;
  /** Items delivered exactly at the high-water time; ties are new only if absent here. */
  private readonly atNewest = new Set<string>();
  private readonly remembered = new Set<string>();

  // ===========================================
  // Observation
  // ===========================================

  /** Whether the baseline has been taken. */
  get started(): boolean {
    return this.baselined;
  }

  /** Record an observation and return its new items in delivery order, oldest first. */
  observe<T extends Delivery>(items: readonly T[]): T[] {
    const timed = items
      .map((item) => ({ item, time: Date.parse(item.createdAt) }))
      .filter(({ time }) => Number.isFinite(time));
    const previous = this.newest;
    const fresh = this.baselined
      ? timed.filter(
          ({ item, time }) =>
            !this.remembered.has(item.id) &&
            (time > previous ||
              (time === previous && !this.atNewest.has(item.id))),
        )
      : [];
    for (const { item, time } of timed) {
      this.remember(item.id);
      if (time > this.newest) {
        this.newest = time;
        this.atNewest.clear();
      }
      if (time === this.newest) this.atNewest.add(item.id);
    }
    this.baselined = true;
    return fresh
      .sort((left, right) => left.time - right.time)
      .map(({ item }) => item);
  }

  /** Forget everything, so the next observation is a new baseline. */
  reset(): void {
    this.baselined = false;
    this.newest = Number.NEGATIVE_INFINITY;
    this.atNewest.clear();
    this.remembered.clear();
  }

  /** Keep a bounded, insertion-ordered list of recent IDs. */
  private remember(id: string): void {
    this.remembered.delete(id);
    this.remembered.add(id);
    if (this.remembered.size > rememberedIdsMax)
      this.remembered.delete(this.remembered.values().next().value!);
  }
}
