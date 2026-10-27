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

/** A host as a Host header names it: a name, an IPv4 address, or a bracketed IPv6 address, then a port. */
const hostPattern = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

/**
 * The cookie host a Host header, or a bare hostname, names: the hostname whose cookies the browser
 * that sent the request attached, normalized as `cookieHost` normalizes a URL's, so `LOCALHOST.:8082`
 * is `localhost`. Undefined for anything but a host and an optional port, such as an empty value,
 * credentials, a path, or several hosts, none of which a browser sends.
 */
export function hostCookieHost(host: string | undefined): string | undefined {
  if (host === undefined || !hostPattern.test(host)) return undefined;
  try {
    return cookieHost(`http://${host}`) || undefined;
  } catch {
    return undefined;
  }
}
