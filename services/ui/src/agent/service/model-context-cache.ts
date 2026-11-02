import {
  providerIds,
  type ProviderConnection,
  type ProviderId,
} from "@everything/provider-contracts";
import {
  inferenceEfforts,
  inferenceSpeeds,
  type InferenceSelection,
} from "@everything/provider-contracts/inference";
import {
  browserStorage,
  type StorageAccess,
} from "../../notification/service/browser-storage.js";
import { contextTokens } from "../model/context-budget.js";

export const contextCacheKey = "everything.model-context.v1";
export const contextFreshMs = 24 * 60 * 60 * 1000;
const retentionMs = 7 * contextFreshMs;
const maximumEntries = 64;
const maximumBytes = 64 * 1024;

/** Only context and small identity/freshness fields are persisted; no profile prose or raw responses. */
interface Entry {
  agentId: string;
  provider: ProviderId;
  model: string;
  effort: string;
  speed: string;
  connection: string;
  revision: string;
  tokens: number | null;
  updatedAt: number;
}

/** A revision prevents an old selection/connection response from writing into a newer one. */
export interface ContextScope {
  readonly owner: string;
  readonly agentId: string;
  readonly provider: ProviderId;
  readonly revision: string;
}

/** Minimal bounded localStorage cache, shared by the real context-row consumers in this tab. */
export class ModelContextCache {
  private loaded = false;
  private owner: string | undefined;
  private entries = new Map<string, Entry>();
  private connections: Partial<Record<ProviderId, string>> = {};
  private observations: Partial<Record<ProviderId, number>> = {};
  private listeners = new Set<() => void>();
  private version = 0;
  private generation = 0;

  /** Storage and time are injectable for expiry/corruption/race tests without a browser. */
  constructor(
    private readonly storage: StorageAccess = browserStorage,
    private readonly now: () => number = Date.now,
    private readonly revision: () => string = () => crypto.randomUUID(),
  ) {}

  /** Stable React external-store subscription; no page-visit freshness extension. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = (): number => this.version;

  /** Restore only the signed-in owner's bucket; switching owners discards the previous bucket. */
  activate(owner: string): void {
    if (!this.loaded) this.restore();
    if (this.owner === owner) return;
    this.owner = owner;
    this.generation++;
    this.entries.clear();
    this.connections = {};
    this.observations = {};
    this.persist();
  }

  /** Logout clears persisted counts and invalidates every late response ticket. */
  clear(): void {
    this.loaded = true;
    this.owner = undefined;
    this.generation++;
    this.entries.clear();
    this.connections = {};
    this.observations = {};
    try {
      this.storage()?.removeItem(contextCacheKey);
    } catch {
      /* Storage is optional. */
    }
    this.changed();
  }

  /** Removing a saved inference selection also retires its response ticket. */
  discard(owner: string, agentId: string): void {
    this.activate(owner);
    if (this.entries.delete(agentId)) this.persist();
  }

  /** Cosmetic profile fields never enter a key; each actual inference change gets a fresh revision. */
  scope(
    owner: string,
    agentId: string,
    selection: InferenceSelection,
  ): ContextScope {
    this.activate(owner);
    this.prune();
    const connection = this.connections[selection.provider] ?? "";
    let entry = this.entries.get(agentId);
    if (
      !entry ||
      entry.provider !== selection.provider ||
      entry.model !== selection.model ||
      entry.effort !== selection.effort ||
      entry.speed !== (selection.speed ?? "standard") ||
      entry.connection !== connection
    ) {
      entry = {
        agentId,
        provider: selection.provider,
        model: selection.model,
        effort: selection.effort,
        speed: selection.speed ?? "standard",
        connection,
        revision: this.revision(),
        tokens: null,
        updatedAt: this.now(),
      };
      this.entries.set(agentId, entry);
      this.prune();
      this.persist();
    }
    return {
      owner,
      agentId,
      provider: selection.provider,
      revision: entry.revision,
    };
  }

  /** Retained expired data can stay visible while a stale-only query refreshes or fails. */
  read(scope: ContextScope): { tokens: number; updatedAt: number } | undefined {
    const entry = this.current(scope);
    return entry &&
      contextTokens(entry.tokens) &&
      this.now() - entry.updatedAt <= retentionMs
      ? { tokens: entry.tokens, updatedAt: entry.updatedAt }
      : undefined;
  }

  /** A late request cannot reactivate an old owner or overwrite a replaced selection. */
  write(scope: ContextScope, tokens: number): boolean {
    const entry = this.current(scope);
    if (!entry || !contextTokens(tokens)) return false;
    this.entries.delete(entry.agentId);
    this.entries.set(entry.agentId, entry);
    entry.tokens = tokens;
    entry.updatedAt = this.now();
    this.persist();
    return true;
  }

  /** Explicit connection edits invalidate even when public identity fields stay unchanged. */
  invalidateProvider(owner: string, provider: ProviderId): void {
    if (this.owner !== owner) return;
    for (const entry of this.entries.values())
      if (entry.provider === provider) {
        entry.revision = this.revision();
        entry.tokens = null;
        entry.updatedAt = this.now();
        entry.connection = this.connections[provider] ?? "";
      }
    this.observations[provider] = (this.observations[provider] ?? 0) + 1;
    this.persist();
    this.changed();
  }

  /** Compare public connection identity using a digest; never persist addresses/accounts themselves. */
  async observeConnection(
    owner: string,
    provider: ProviderId,
    connection?: ProviderConnection,
  ): Promise<void> {
    if (this.owner !== owner) return;
    const generation = this.generation;
    const observation = (this.observations[provider] ?? 0) + 1;
    this.observations[provider] = observation;
    const identity = JSON.stringify([
      provider,
      connection
        ? [
            connection.configured,
            connection.baseUrl,
            connection.model,
            connection.account,
          ]
        : null,
    ]);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(identity),
    );
    if (
      this.owner !== owner ||
      this.generation !== generation ||
      this.observations[provider] !== observation
    )
      return;
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (this.connections[provider] === hash) return;
    this.connections[provider] = hash;
    this.invalidateProvider(owner, provider);
  }

  private current(scope: ContextScope): Entry | undefined {
    const entry = this.entries.get(scope.agentId);
    return this.owner === scope.owner &&
      entry?.provider === scope.provider &&
      entry.revision === scope.revision
      ? entry
      : undefined;
  }

  private changed(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private prune(): void {
    const now = this.now();
    const entries = [...this.entries.values()]
      .filter((e) => e.updatedAt <= now && now - e.updatedAt <= retentionMs)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(-maximumEntries);
    this.entries = new Map(entries.map((e) => [e.agentId, e]));
  }

  private restore(): void {
    this.loaded = true;
    try {
      const text = this.storage()?.getItem(contextCacheKey);
      if (!text) return;
      if (
        text.length > maximumBytes ||
        new TextEncoder().encode(text).length > maximumBytes
      )
        throw new Error("Oversized context cache");
      const data = JSON.parse(text) as {
        version?: unknown;
        owner?: unknown;
        connections?: unknown;
        entries?: unknown;
      };
      if (
        data?.version !== 1 ||
        !shortString(data.owner) ||
        !Array.isArray(data.entries) ||
        data.entries.length > maximumEntries ||
        typeof data.connections !== "object" ||
        data.connections === null ||
        Array.isArray(data.connections)
      )
        throw new Error("Invalid context cache");
      const connections: Partial<Record<ProviderId, string>> = {};
      for (const [key, value] of Object.entries(data.connections)) {
        if (
          !providerIds.includes(key as ProviderId) ||
          typeof value !== "string" ||
          !/^[0-9a-f]{64}$/.test(value)
        )
          throw new Error("Invalid connection cache");
        connections[key as ProviderId] = value;
      }
      const entries = data.entries.map(validEntry);
      if (entries.some((e) => !e)) throw new Error("Invalid context entry");
      this.owner = data.owner;
      this.connections = connections;
      this.entries = new Map(entries.map((e) => [e!.agentId, e!]));
      this.prune();
    } catch {
      this.entries.clear();
      this.connections = {};
      this.owner = undefined;
      try {
        this.storage()?.removeItem(contextCacheKey);
      } catch {
        /* Keep the UI usable without storage. */
      }
    }
  }

  private persist(): void {
    this.prune();
    if (!this.owner) return;
    try {
      let text: string;
      do {
        text = JSON.stringify({
          version: 1,
          owner: this.owner,
          connections: this.connections,
          entries: [...this.entries.values()],
        });
        if (new TextEncoder().encode(text).length <= maximumBytes) break;
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) return;
        this.entries.delete(oldest);
      } while (true);
      this.storage()?.setItem(contextCacheKey, text);
    } catch {
      /* In-memory query data still works when storage is blocked or full. */
    }
  }
}

function shortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** Reconstruct known fields only; untrusted storage never supplies arbitrary response data. */
function validEntry(value: unknown): Entry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const e = value as Entry;
  if (
    !shortString(e.agentId) ||
    !shortString(e.model) ||
    !providerIds.includes(e.provider) ||
    !inferenceEfforts.includes(e.effort as never) ||
    !inferenceSpeeds.includes(e.speed as never) ||
    typeof e.connection !== "string" ||
    (e.connection !== "" && !/^[0-9a-f]{64}$/.test(e.connection)) ||
    typeof e.revision !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(e.revision) ||
    (e.tokens !== null && !contextTokens(e.tokens)) ||
    !Number.isSafeInteger(e.updatedAt) ||
    e.updatedAt < 0
  )
    return undefined;
  return {
    agentId: e.agentId,
    provider: e.provider,
    model: e.model,
    effort: e.effort,
    speed: e.speed,
    connection: e.connection,
    revision: e.revision,
    tokens: e.tokens,
    updatedAt: e.updatedAt,
  };
}
