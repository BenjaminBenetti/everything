import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hostCookieHost } from "@everything/security/cookie-host";
import { hostMessages, hostPage } from "../presenter/host-pages.js";

/**
 * Admits a viewer host's requests only for its own hostnames. Browsers keep cookies by hostname, not
 * port, so a host that answered another hostname would receive that hostname's cookies and could set
 * its own there: the public apps host answering `localhost` would forward cookies private apps set,
 * and the artifact host answering the public apps host's `127.0.0.1` would store a teammate pass, and
 * let a private app set its cookies, where every public app receives them.
 *
 * The hostname comes from the request's own Host header, which the ingress passes on as the browser
 * sent it. X-Forwarded-Host and Forwarded are never read: anyone can send them, and Fastify's
 * `request.host` takes X-Forwarded-Host over the Host header behind a trusted proxy.
 */
export class HostAdmission {
  // ===========================================
  // State
  // ===========================================

  private readonly hostnames: ReadonlySet<string>;

  // ===========================================
  // Construction
  // ===========================================

  /** Admit these hostnames, each already a cookie host: lowercase, with no port or trailing dot. */
  constructor(hostnames: readonly string[]) {
    if (hostnames.length === 0)
      throw new Error("A viewer host needs a hostname to serve");
    for (const hostname of hostnames)
      if (hostCookieHost(hostname) !== hostname)
        throw new Error("A viewer host's hostnames must be cookie hosts");
    this.hostnames = new Set(hostnames);
  }

  // ===========================================
  // Operations
  // ===========================================

  /**
   * Whether the request names one of these hostnames, on any port, in its only Host header, for a
   * path on this host. A request with no Host header or several, one naming anything but a host and
   * an optional port, or a target that is a full URL or `*`, which no browser sends to a host, is not.
   */
  admits(request: IncomingMessage): boolean {
    let hostHeaders = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      if (request.rawHeaders[index]!.toLowerCase() === "host") hostHeaders++;
    const hostname = hostCookieHost(request.headers.host);
    return (
      hostHeaders === 1 &&
      hostname !== undefined &&
      this.hostnames.has(hostname) &&
      (request.url ?? "").startsWith("/")
    );
  }

  /**
   * Refuse other requests first, ahead of hooks registered after this one, routes, and the
   * not-found handler: before any cookie is read or written, any app is looked up, served, or
   * forwarded to, and any sign-in link, pass, or API key is checked. The refusal is never cached.
   */
  register(app: FastifyInstance): void {
    app.addHook(
      "onRequest",
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        if (this.admits(request.raw)) return;
        await reply
          .code(421)
          .header("Cache-Control", "no-store")
          .type("text/html; charset=utf-8")
          .send(
            hostPage(
              hostMessages.wrongHost.title,
              hostMessages.wrongHost.message,
            ),
          );
      },
    );
  }
}
