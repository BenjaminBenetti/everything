import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OidcIdentityVerifier } from "@everything/security/oidc";
import { providerLimits } from "@everything/provider-contracts";
import type { ChatGptAuthorization } from "../interface/chatgpt-authorization.js";
import type {
  PendingAuthorization,
  ProviderCredential,
} from "../model/stored-provider.js";
import { ProviderAuthorizationError } from "../error/provider-errors.js";

const resource = "https://api.openai.com/v1";
const tokenEndpoint = "https://auth.openai.com/api/accounts/oauth/token";
const initialClient = "dynamic_agent_client";

/** Public-client dynamic registration for the new open-source Sign in with ChatGPT flow. */
export class OpenAiChatGptAuthorization implements ChatGptAuthorization {
  // ===========================================
  // Construction
  // ===========================================

  /** Keep the exact loopback callback separate from the application's public hostname. */
  constructor(
    private readonly identity: OidcIdentityVerifier,
    private readonly redirectUri: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const callback = new URL(redirectUri);
    if (
      callback.protocol !== "http:" ||
      callback.hostname !== "127.0.0.1" ||
      callback.search ||
      callback.hash
    )
      throw new Error("ChatGPT requires an HTTP loopback callback");
  }

  // ===========================================
  // Authorization lifecycle
  // ===========================================

  /** Generate a fresh PKCE attempt while reusing this host and its existing registration. */
  begin(saved: ProviderCredential) {
    const credential = {
      ...saved,
      hostId: saved.hostId ?? `urn:uuid:${randomUUID()}`,
    };
    const pending: PendingAuthorization = {
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      verifier: randomBytes(48).toString("base64url"),
      redirectUri: this.redirectUri,
      clientId: saved.clientId ?? initialClient,
      expiresAt: Date.now() + providerLimits.authorizationLifetimeMs,
    };
    const url = new URL("https://auth.openai.com/api/accounts/authorize");
    url.search = new URLSearchParams({
      client_id: pending.clientId,
      ext_agent_host_id: credential.hostId,
      ...(pending.clientId === initialClient
        ? { agent_name_hint: "Everything" }
        : {}),
      response_type: "code",
      redirect_uri: pending.redirectUri,
      scope:
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(pending.verifier)
        .digest("base64url"),
    }).toString();
    return {
      credential,
      pending,
      authorization: {
        url: url.href,
        redirectUri: pending.redirectUri,
        expiresAt: new Date(pending.expiresAt).toISOString(),
      },
    };
  }

  /** Reject foreign, expired, replayed, or declined callbacks before any token request. */
  async complete(
    saved: ProviderCredential,
    pending: PendingAuthorization,
    callback: string,
    retainRegistration: (credential: ProviderCredential) => Promise<void>,
  ) {
    let url: URL;
    try {
      url = new URL(callback);
    } catch {
      throw new ProviderAuthorizationError();
    }
    const expected = new URL(pending.redirectUri);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.hash ||
      pending.expiresAt <= Date.now()
    )
      throw new ProviderAuthorizationError();
    for (const name of ["state", "code", "client_id", "error"])
      if (url.searchParams.getAll(name).length > 1)
        throw new ProviderAuthorizationError();
    if (url.searchParams.get("state") !== pending.state)
      throw new ProviderAuthorizationError();
    if (url.searchParams.has("error"))
      throw new ProviderAuthorizationError(
        "ChatGPT sign-in was cancelled. You can try again when ready.",
      );
    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("client_id") ?? pending.clientId;
    if (
      !code ||
      !clientId ||
      clientId === initialClient ||
      (pending.clientId !== initialClient && clientId !== pending.clientId)
    )
      throw new ProviderAuthorizationError();
    const registered = { ...saved, clientId };
    await retainRegistration(registered);
    const data = await this.tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource,
    });
    if (typeof data.id_token !== "string")
      throw new ProviderAuthorizationError();
    let account;
    try {
      account = await this.identity.verify(
        data.id_token,
        clientId,
        pending.nonce,
      );
    } catch {
      throw new ProviderAuthorizationError();
    }
    if (saved.subject && saved.subject !== account.subject)
      throw new ProviderAuthorizationError(
        "This sign-in belongs to a different ChatGPT account.",
      );
    return {
      credential: {
        ...this.credentials(registered, data),
        subject: account.subject,
      },
      account: account.email ?? "ChatGPT account",
    };
  }

  /** Rotate the token set together and verify any replacement ID token against the same account. */
  async refresh(saved: ProviderCredential): Promise<ProviderCredential> {
    if (!saved.accessToken || !saved.clientId || !saved.refreshToken)
      throw new ProviderAuthorizationError("Reconnect ChatGPT to continue.");
    if ((saved.expiresAt ?? 0) > Date.now() + 60_000) return saved;
    const data = await this.tokenRequest({
      grant_type: "refresh_token",
      client_id: saved.clientId,
      refresh_token: saved.refreshToken,
      resource,
    });
    if (typeof data.id_token === "string") {
      let account;
      try {
        account = await this.identity.verify(data.id_token, saved.clientId);
      } catch {
        throw new ProviderAuthorizationError();
      }
      if (account.subject !== saved.subject)
        throw new ProviderAuthorizationError();
    }
    return this.credentials(saved, data);
  }

  /** Clear local tokens even if a remote revocation cannot be confirmed. */
  async revoke(saved: ProviderCredential): Promise<boolean> {
    if (!saved.refreshToken || !saved.clientId) return true;
    try {
      const response = await this.fetcher(
        "https://auth.openai.com/api/accounts/oauth/revoke",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({
            token: saved.refreshToken,
            token_type_hint: "refresh_token",
            client_id: saved.clientId,
          }),
        },
      );
      return response.status === 200;
    } catch {
      return false;
    }
  }

  // ===========================================
  // Token validation
  // ===========================================

  /** Send public-client grants only to OpenAI, with a bounded request and no logged body. */
  private async tokenRequest(
    parameters: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetcher(tokenEndpoint, {
        method: "POST",
        body: new URLSearchParams(parameters),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new ProviderAuthorizationError();
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderAuthorizationError();
    }
  }

  /** Require the actual plan-use scope and an expiring bearer token before saving a grant. */
  private credentials(
    saved: ProviderCredential,
    data: Record<string, unknown>,
  ): ProviderCredential {
    const scopes =
      typeof data.scope === "string"
        ? data.scope.split(/\s+/)
        : (saved.scopes ?? []);
    if (
      !scopes.includes("chatgpt.tokens.use.direct") ||
      !scopes.includes("resource.invoke")
    )
      throw new ProviderAuthorizationError(
        "Allow ChatGPT plan usage during sign-in, then try again.",
      );
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.expires_in !== "number" ||
      data.expires_in <= 0 ||
      typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer"
    )
      throw new ProviderAuthorizationError();
    const refreshToken =
      typeof data.refresh_token === "string"
        ? data.refresh_token
        : saved.refreshToken;
    if (!refreshToken)
      throw new ProviderAuthorizationError(
        "Allow offline access so your ChatGPT connection can be saved.",
      );
    return {
      ...saved,
      accessToken: data.access_token,
      refreshToken,
      scopes,
      expiresAt: Date.now() + data.expires_in * 1000,
      ...(typeof data.id_token === "string" ? { idToken: data.id_token } : {}),
    };
  }
}
