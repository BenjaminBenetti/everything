import type { FastifyReply, FastifyRequest } from "fastify";
import { viewSessionLifetimeMs } from "../model/view-credential.js";

/** Cookie names of the Everything application's own session, never forwarded to artifacts. */
const applicationSessionCookies = [
  "everything-session",
  "__Host-everything-session",
];

/** Owns the artifact host's session cookie. */
export class ViewCookie {
  // ===========================================
  // State
  // ===========================================

  readonly name: string;
  private readonly secure: boolean;

  // ===========================================
  // Construction
  // ===========================================

  /** Use a `__Host-` cookie when the artifact host is served over HTTPS. */
  constructor(artifactOrigin: string) {
    this.secure = new URL(artifactOrigin).protocol === "https:";
    this.name = this.secure
      ? "__Host-everything-artifact-session"
      : "everything-artifact-session";
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Read the session token. */
  read(request: FastifyRequest): string | undefined {
    return request.cookies[this.name];
  }

  /** Send a host-only HttpOnly cookie; Lax lets links from other sites open artifacts. */
  write(reply: FastifyReply, token: string): void {
    reply.setCookie(this.name, token, {
      path: "/",
      httpOnly: true,
      secure: this.secure,
      sameSite: "lax",
      maxAge: viewSessionLifetimeMs / 1000,
    });
  }

  /** Login cookies that must not reach an artifact's own server. */
  get privateCookies(): readonly string[] {
    return [this.name, ...applicationSessionCookies];
  }
}
