import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OciChartRegistry,
  chartLocation,
} from "../adapter/oci-chart-registry.js";
import { CachedChartVersions } from "../service/cached-chart-versions.js";

/** A recorded request: its URL and the authorization it carried. */
interface Request {
  readonly url: string;
  readonly authorization: string | null;
}

/** A fetcher answering from a function of the URL and headers, recording each request. */
function registry(
  answer: (url: URL, authorization: string | null) => Response,
): { fetcher: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ url: url.href, authorization });
    assert.equal(init?.redirect, "error");
    return answer(url, authorization);
  }) as typeof fetch;
  return { fetcher, requests };
}

/** A JSON response. */
function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("lists every page of tags with an anonymous token when the registry challenges", async () => {
  const challenge =
    'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:owner/everything/charts/everything:pull"';
  const { fetcher, requests } = registry((url, authorization) => {
    if (url.pathname === "/token") {
      assert.equal(url.searchParams.get("service"), "ghcr.io");
      assert.equal(
        url.searchParams.get("scope"),
        "repository:owner/everything/charts/everything:pull",
      );
      assert.equal(authorization, null);
      return json({ token: "anonymous" });
    }
    if (authorization !== "Bearer anonymous")
      return json(
        {},
        { status: 401, headers: { "www-authenticate": challenge } },
      );
    if (url.searchParams.get("last") === "0.1.0")
      return json({ tags: ["0.1.1_build.2", "sha256-abc.sig"] });
    return json(
      {
        name: "owner/everything/charts/everything",
        tags: ["0.1.0-rc7", "0.1.0"],
      },
      {
        headers: {
          link: '</v2/owner/everything/charts/everything/tags/list?last=0.1.0&n=1000>; rel="next"',
        },
      },
    );
  });
  const versions = await new OciChartRegistry(
    "oci://ghcr.io/owner/everything/charts/everything",
    false,
    fetcher,
  ).published();
  assert.deepEqual(versions, [
    "0.1.0-rc7",
    "0.1.0",
    "0.1.1+build.2",
    "sha256-abc.sig",
  ]);
  assert.equal(
    requests[0]!.url,
    "https://ghcr.io/v2/owner/everything/charts/everything/tags/list?n=1000",
  );
  assert.equal(
    requests.filter((request) => request.url.includes("/token")).length,
    1,
  );
});

test("never follows pages to another origin or sends the token there", async () => {
  const { fetcher, requests } = registry(() =>
    json(
      { tags: ["1.0.0"] },
      {
        headers: {
          link: '<https://elsewhere.test/v2/x/tags/list?last=1>; rel="next"',
        },
      },
    ),
  );
  assert.deepEqual(
    await new OciChartRegistry(
      "oci://registry.test:5000/charts/everything",
      true,
      fetcher,
    ).published(),
    ["1.0.0"],
  );
  assert.deepEqual(
    requests.map((request) => request.url),
    ["http://registry.test:5000/v2/charts/everything/tags/list?n=1000"],
  );
});

test("refuses unexpected answers and token realms that downgrade to HTTP", async () => {
  const missing = registry(() => json({ errors: [] }, { status: 404 }));
  await assert.rejects(
    new OciChartRegistry(
      "oci://registry.test/charts/x",
      false,
      missing.fetcher,
    ).published(),
    /answered 404/,
  );
  const downgrade = registry(() =>
    json(
      {},
      {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer realm="http://registry.test/token"',
        },
      },
    ),
  );
  await assert.rejects(
    new OciChartRegistry(
      "oci://registry.test/charts/x",
      false,
      downgrade.fetcher,
    ).published(),
    /unsupported sign-in/,
  );
  assert.throws(() => chartLocation("https://registry.test/charts/x", false));
});

test("reuses a listing until it expires, and lists afresh on request", async () => {
  let calls = 0;
  let now = 0;
  const cached = new CachedChartVersions(
    { published: async () => [`1.0.${calls++}`] },
    1000,
    () => now,
  );
  assert.deepEqual(await cached.published(), ["1.0.0"]);
  assert.deepEqual(await cached.published(), ["1.0.0"]);
  assert.deepEqual(await cached.published({ fresh: true }), ["1.0.1"]);
  now = 2000;
  assert.deepEqual(await cached.published(), ["1.0.2"]);
});
