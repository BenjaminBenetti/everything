import type { FastifyReplyFromOptions } from "@fastify/reply-from";

/**
 * How long a dynamic app may stay silent, before its response headers or between body bytes, before
 * the host gives up on it: the 300-second header and body defaults of the Undici client used before.
 */
export const appIdleTimeout = 300_000;

/** The most connections one host opens to one app at a time, as the former Undici pool allowed. */
export const appConnections = 128;

/** How long an idle connection to an app stays open for the next request, as Undici's default allowed. */
export const appKeepAliveTimeout = 4_000;

/**
 * reply-from options for each host that forwards to dynamic apps. Requests go through Node's own
 * HTTP/1.1 client instead of reply-from's default, its bundled Undici 7 client, whose response parser
 * can fail an internal assertion when an app's connection ends and throw outside any request. Each
 * call returns a fresh object, because reply-from fills in the options it is given, and each host's
 * registration owns its connections and closes them when the host closes.
 */
export function appForwarding(): FastifyReplyFromOptions {
  return {
    disableRequestLogging: true,
    destroyAgent: true,
    http: {
      agentOptions: {
        keepAlive: true,
        maxSockets: appConnections,
        maxFreeSockets: appConnections,
        // Applies to idle pooled connections only: each request sets its own timeout below.
        timeout: appKeepAliveTimeout,
      },
      requestOptions: { timeout: appIdleTimeout },
    },
  };
}
