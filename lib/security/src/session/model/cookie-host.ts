/**
 * The host a browser keeps a URL's host-only cookies under: its hostname, lowercase and without a
 * trailing dot. Browsers scope cookies by hostname and path, not by port or scheme, so every port of
 * one hostname shares the cookies any of them sets without a `Domain` attribute.
 */
export function cookieHost(url: string): string {
  return new URL(url).hostname.replace(/\.+$/, "");
}

/** Whether two URLs share a cookie host, whatever their ports and schemes. */
export function sharesCookieHost(first: string, second: string): boolean {
  return cookieHost(first) === cookieHost(second);
}
