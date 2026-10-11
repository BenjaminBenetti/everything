import type { FastifyRequest, FastifyReply } from "fastify";
import { SessionOriginRejected } from "../error/session-errors.js";
import { sessionLifetimeMs } from "../model/stored-session.js";

/** Own cookie and same-origin policy independently from session use cases. */
export class SessionCookie {
  // ===========================================
  // Construction
  // ===========================================

  private readonly secure: boolean;
  private readonly name: string;

  /** Derive transport policy only from trusted deployment configuration. */
  constructor(private readonly publicOrigin: string) {
    const origin = new URL(publicOrigin);
    if (
      origin.origin !== publicOrigin ||
      !["http:", "https:"].includes(origin.protocol)
    )
      throw new Error("PUBLIC_ORIGIN must be an HTTP origin");
    this.secure = origin.protocol === "https:";
    this.name = this.secure
      ? "__Host-everything-session"
      : "everything-session";
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Read only the opaque capability, never provider credentials. */
  read(request: FastifyRequest): string | undefined {
    return request.cookies[this.name];
  }

  /** Send a host-only HttpOnly cookie with a fixed lifetime and strict same-site policy. */
  write(reply: FastifyReply, handle: string): void {
    reply.setCookie(this.name, handle, {
      path: "/",
      httpOnly: true,
      secure: this.secure,
      sameSite: "strict",
      maxAge: sessionLifetimeMs / 1000,
    });
  }

  /** Clear with the same host, path, and transport policy as creation. */
  clear(reply: FastifyReply): void {
    reply.clearCookie(this.name, {
      path: "/",
      httpOnly: true,
      secure: this.secure,
      sameSite: "strict",
    });
  }

  /** Require an exact trusted origin for session creation, logout, and cookie-authenticated mutations. */
  requireOrigin(request: FastifyRequest): void {
    if (
      request.headers.origin !== this.publicOrigin ||
      (request.headers["sec-fetch-site"] &&
        request.headers["sec-fetch-site"] !== "same-origin")
    )
      throw new SessionOriginRejected();
  }

  /** Bearer API clients remain independent of browser-cookie CSRF policy. */
  protectMutation(request: FastifyRequest): void {
    if (
      request.headers.authorization === undefined &&
      this.read(request) &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    )
      this.requireOrigin(request);
  }
}
