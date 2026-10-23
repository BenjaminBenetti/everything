import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import type {
  TelemetryRow,
  TelemetrySearch,
  TelemetryStreamType,
  TelemetryWindow,
} from "../interface/telemetry-search.js";
import type { TelemetryBackendSettings } from "../model/telemetry-settings.js";
import { TelemetrySearchError } from "../error/telemetry-errors.js";

/** OpenObserve's error code for a search of a stream that has never received a record. */
const streamNotFound = 20002;

/**
 * Query OpenObserve's search API inside the cluster with credentials only this process holds.
 * Requests are bounded by the configured deadline, never followed through redirects, and run
 * with tracing suppressed, so reading telemetry does not record more of it.
 */
export class OpenObserveSearch implements TelemetrySearch {
  // ===========================================
  // Construction
  // ===========================================

  /** Use the configured backend, and `fetcher` for transport. */
  constructor(
    private readonly backend: TelemetryBackendSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Run one query; a stream that does not exist yet has no rows. */
  async search(
    type: TelemetryStreamType,
    sql: string,
    window: TelemetryWindow,
    size: number,
  ): Promise<TelemetryRow[]> {
    const response = await this.request(`/_search?type=${type}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: {
          sql,
          start_time: Math.trunc(window.start),
          end_time: Math.trunc(window.end),
          from: 0,
          size,
        },
      }),
    });
    const body = (await response.json().catch(() => undefined)) as
      { hits?: unknown; code?: unknown } | undefined;
    if (!response.ok) {
      const code = typeof body?.code === "number" ? body.code : undefined;
      if (code === streamNotFound) return [];
      throw new TelemetrySearchError(code);
    }
    if (!Array.isArray(body?.hits)) throw new TelemetrySearchError();
    return body.hits.filter(
      (hit): hit is TelemetryRow => !!hit && typeof hit === "object",
    );
  }

  /** The stream's columns, or none before it exists. */
  async fields(type: TelemetryStreamType): Promise<ReadonlySet<string>> {
    const response = await this.request(
      `/streams/${this.backend.stream}/schema?type=${type}`,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 404) return new Set();
      throw new TelemetrySearchError();
    }
    const body = (await response.json().catch(() => undefined)) as
      { schema?: { name?: unknown }[] } | undefined;
    if (!Array.isArray(body?.schema)) throw new TelemetrySearchError();
    return new Set(
      body.schema
        .map((field) => field?.name)
        .filter((name): name is string => typeof name === "string"),
    );
  }

  /** Whether an authenticated request succeeds. */
  async available(): Promise<boolean> {
    try {
      const response = await this.request("/streams?type=logs");
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  // ===========================================
  // Transport
  // ===========================================

  /** One authenticated request to the organization's API, without tracing it. */
  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${this.backend.username}:${this.backend.password}`).toString("base64")}`,
    );
    try {
      return await context.with(suppressTracing(context.active()), () =>
        this.fetcher(
          `${this.backend.url}/api/${this.backend.organization}${path}`,
          {
            ...init,
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(this.backend.timeoutMs),
          },
        ),
      );
    } catch {
      throw new TelemetrySearchError();
    }
  }
}
