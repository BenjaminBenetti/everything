import type { FastifyRequest, FastifyReply } from "fastify";
import { credentialSource } from "@everything/security/fastify";
import {
  SessionOriginRejected,
  SignedInUserRequired,
} from "../error/session-errors.js";
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

  /**
   * Admit only a person signed in to this application in their browser. The verified token must come
   * from the server-owned session, which only a password sign-in on this origin creates and whose
   * tokens never leave the server, and the request must come from the exact application origin.
   * App and teammate credentials act for their owner as bearer tokens, so they are refused even for
   * the owner's own resources, as is an app page or other site causing a signed-in browser to call.
   */
  requireSignedInUser(request: FastifyRequest): void {
    if (credentialSource(request) !== "session")
      throw new SignedInUserRequired();
    this.requireOrigin(request);
  }

  /**
   * WebSocket upgrades are GET requests that carry the session cookie, so cookie-authenticated
   * upgrades need the exact origin check mutations get; bearer clients remain independent of it.
   */
  protectUpgrade(request: FastifyRequest): void {
    if (request.headers.authorization === undefined && this.read(request))
      this.requireOrigin(request);
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
