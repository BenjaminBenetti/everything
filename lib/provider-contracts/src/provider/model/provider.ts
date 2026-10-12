/** Connection choices supported by the application. */
export const providerIds = [
  "chatgpt",
  "anthropic",
  "openai-compatible",
] as const;
export type ProviderId = (typeof providerIds)[number];
export type ApiKeyProviderId = Exclude<ProviderId, "chatgpt">;

/** Shared input bounds and intervals for connection checks and authorization. */
export const providerLimits = {
  apiKeyLength: 8192,
  addressLength: 2048,
  modelLength: 200,
  callbackLength: 16384,
  verificationIntervalMs: 24 * 60 * 60 * 1000,
  authorizationLifetimeMs: 10 * 60 * 1000,
} as const;

/** Public connection state contains neither credentials nor authorization attempts. */
export interface ProviderConnection {
  readonly provider: ProviderId;
  readonly configured: boolean;
  readonly status: "disconnected" | "unverified" | "verified" | "error";
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly account: string | null;
  readonly verifiedAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly message: string | null;
}

/** API keys are write-only; omission keeps an existing key for the same address. */
export interface SaveProviderInput {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

/** A short-lived browser authorization, without OAuth credentials. */
export interface ProviderAuthorization {
  readonly url: string;
  readonly redirectUri: string;
  readonly expiresAt: string;
}

/** Disconnect reports whether the upstream renewable session was revoked. */
export interface ProviderDisconnection {
  readonly message: string | null;
}
