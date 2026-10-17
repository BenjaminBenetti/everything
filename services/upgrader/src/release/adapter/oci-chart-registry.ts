import type { ChartVersions } from "../interface/chart-versions.js";
import { versionFromTag } from "../model/release-versions.js";

/** Each registry request gives up after this long. */
const requestTimeoutMs = 15_000;
/** Tags requested per page, and the most pages read, which bound one listing's work. */
const pageSize = 1000;
const maxPages = 20;

/** A chart's registry origin and repository, from `oci://<host>/<repository>`. */
interface ChartLocation {
  readonly origin: string;
  readonly repository: string;
}

/**
 * Lists a chart's published versions through the OCI distribution API, as Helm stores each version
 * as a tag of the chart's repository. Registries that require a token for public repositories,
 * such as GitHub's, issue one anonymously; no credential is ever sent.
 */
export class OciChartRegistry implements ChartVersions {
  // ===========================================
  // Construction
  // ===========================================

  private readonly location: ChartLocation;

  /** Bind the chart's `oci://` reference; the fetcher is replaceable for tests. */
  constructor(
    chart: string,
    private readonly plainHttp: boolean,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.location = chartLocation(chart, plainHttp);
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Read every page of the repository's tags, signing in anonymously when the registry asks. */
  async published(): Promise<string[]> {
    const { origin, repository } = this.location;
    const tags: string[] = [];
    let token: string | undefined;
    let next: string | undefined =
      `${origin}/v2/${repository}/tags/list?n=${pageSize}`;
    for (let page = 0; next && page < maxPages; page++) {
      let response = await this.get(next, token);
      if (response.status === 401 && token === undefined) {
        token = await this.anonymousToken(response);
        response = await this.get(next, token);
      }
      if (!response.ok)
        throw new Error(`The chart registry answered ${response.status}`);
      const body = (await response.json()) as { tags?: unknown };
      if (body.tags != null && !Array.isArray(body.tags))
        throw new Error("The chart registry returned an invalid tag list");
      for (const tag of body.tags ?? [])
        if (typeof tag === "string") tags.push(tag);
      next = nextPage(response.headers.get("link"), origin);
    }
    return tags.map(versionFromTag);
  }

  // ===========================================
  // Registry boundary
  // ===========================================

  /** Request one URL, with the anonymous token once the registry has issued one. */
  private get(url: string, token: string | undefined): Promise<Response> {
    return this.fetcher(url, {
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  }

  /** Request an anonymous pull token from the realm the registry's challenge names. */
  private async anonymousToken(challenge: Response): Promise<string> {
    const parameters = bearerChallenge(
      challenge.headers.get("www-authenticate"),
    );
    const realm = parameters.get("realm");
    if (!realm || !allowedUrl(realm, this.plainHttp))
      throw new Error("The chart registry requires an unsupported sign-in");
    const url = new URL(realm);
    url.searchParams.set(
      "scope",
      parameters.get("scope") ?? `repository:${this.location.repository}:pull`,
    );
    const service = parameters.get("service");
    if (service) url.searchParams.set("service", service);
    const response = await this.fetcher(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok)
      throw new Error(
        `The chart registry refused an anonymous token (${response.status})`,
      );
    const body = (await response.json()) as Record<string, unknown>;
    const token = body.token ?? body.access_token;
    if (typeof token !== "string" || !token)
      throw new Error("The chart registry returned an invalid token");
    return token;
  }
}

// ===========================================
// Parsing
// ===========================================

/** Split `oci://<host>/<repository>` into the registry's API origin and the repository. */
export function chartLocation(
  chart: string,
  plainHttp: boolean,
): ChartLocation {
  const match = /^oci:\/\/([^/\s]+)\/([^\s]+)$/.exec(chart);
  if (!match) throw new Error("The chart must be an oci:// reference");
  return {
    origin: `${plainHttp ? "http" : "https"}://${match[1]}`,
    repository: match[2]!.replace(/\/+$/, ""),
  };
}

/** The parameters of a `Bearer realm="…",service="…",scope="…"` challenge. */
function bearerChallenge(header: string | null): Map<string, string> {
  const parameters = new Map<string, string>();
  if (!header || !/^Bearer\s/i.test(header)) return parameters;
  for (const [, name, value] of header.matchAll(/(\w+)="([^"]*)"/g))
    parameters.set(name!.toLowerCase(), value!);
  return parameters;
}

/** The next page from a `Link: <…>; rel="next"` header, only on the registry's own origin. */
function nextPage(header: string | null, origin: string): string | undefined {
  const target = header && /<([^>]+)>\s*;\s*rel="?next"?/i.exec(header)?.[1];
  if (!target) return undefined;
  const url = new URL(target, origin);
  return url.origin === origin ? url.href : undefined;
}

/** Token realms must use HTTPS, or HTTP when the registry itself does. */
function allowedUrl(value: string, plainHttp: boolean): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || (plainHttp && protocol === "http:");
  } catch {
    return false;
  }
}
