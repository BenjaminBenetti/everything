/** Bound provider requests and prevent redirects from carrying credentials to another host. */
export function providerFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => fetcher(input, { ...init, redirect: "error" });
}
