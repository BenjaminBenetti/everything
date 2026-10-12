import type { FastifyReply, FastifyRequest } from "fastify";
import { viewPassPrefix } from "../model/view-credential.js";

/** A bearer token in an Authorization header. */
const bearerPattern = /^Bearer +(\S+) *$/i;

/** The teammate pass in an Authorization header; an artifact's own tokens yield undefined. */
export function viewPassBearer(
  authorization: string | undefined,
): string | undefined {
  const token = authorization?.match(bearerPattern)?.[1];
  return token?.startsWith(viewPassPrefix) ? token : undefined;
}

/** Reads teammate passes from requests and keeps a browser's pass in a cookie. */
export class ViewPassCredentials {
  // ===========================================
  // State
  // ===========================================

  /**
   * Cookie holding a browser's pass. It has no `__Host-` prefix, which would require `Secure`:
   * teammates browse the artifact host over plain HTTP inside the cluster.
   */
  readonly cookieName = "everything-teammate-pass";

  // ===========================================
  // Operations
  // ===========================================

  /** The pass sent as a bearer token, or else in the cookie; values without its prefix are ignored. */
  read(request: FastifyRequest): string | undefined {
    const cookie = request.cookies[this.cookieName];
    return (
      viewPassBearer(request.headers.authorization) ??
      (cookie?.startsWith(viewPassPrefix) ? cookie : undefined)
    );
  }

  /**
   * Keep the pass for the artifact's paths until it expires. It is `Secure` only when the browser
   * connected over HTTPS; browsers drop `Secure` cookies sent over plain HTTP.
   */
  write(
    request: FastifyRequest,
    reply: FastifyReply,
    pass: { readonly token: string; readonly expiresAt: string },
    slug: string,
  ): void {
    reply.setCookie(this.cookieName, pass.token, {
      path: `/${slug}`,
      httpOnly: true,
      secure: request.protocol === "https",
      sameSite: "lax",
      maxAge: Math.max(
        0,
        Math.floor((Date.parse(pass.expiresAt) - Date.now()) / 1000),
      ),
    });
  }
}
