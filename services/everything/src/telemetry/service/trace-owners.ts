/** One trace's owner, learned when its request was authenticated. */
interface TraceOwner {
  readonly ownerId: string;
  readonly agentId: string | undefined;
  readonly expiresAt: number;
}

/**
 * Owners of recent request traces, so spans that started before authentication, such as the session
 * lookup, are attributed to the request's owner too. Bounded in size and age; a trace whose entry has
 * gone keeps the owner on every span that started or ended after authentication.
 */
export class TraceOwners {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly owners = new Map<string, TraceOwner>();

  /** Keep at most `capacity` traces for `lifetimeMs` each. */
  constructor(
    private readonly capacity = 4096,
    private readonly lifetimeMs = 10 * 60_000,
    private readonly now: () => number = () => performance.now(),
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Record a trace's verified owner, and the teammate it concerns when known. */
  set(traceId: string, ownerId: string, agentId?: string): void {
    this.owners.delete(traceId);
    this.owners.set(traceId, {
      ownerId,
      agentId,
      expiresAt: this.now() + this.lifetimeMs,
    });
    while (this.owners.size > this.capacity)
      this.owners.delete(this.owners.keys().next().value!);
  }

  /** The trace's owner while it is remembered. */
  get(traceId: string): Omit<TraceOwner, "expiresAt"> | undefined {
    const owner = this.owners.get(traceId);
    if (!owner) return undefined;
    if (owner.expiresAt <= this.now()) {
      this.owners.delete(traceId);
      return undefined;
    }
    return { ownerId: owner.ownerId, agentId: owner.agentId };
  }
}

/** The process's request owners, shared by request handling and span processing. */
export const traceOwners = new TraceOwners();
