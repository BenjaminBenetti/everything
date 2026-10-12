import type { ProviderCredential } from "../model/stored-provider.js";

/** Minimal data needed to check a provider without opening a teammate session. */
export interface VerificationInput {
  readonly credential: ProviderCredential;
  readonly baseUrl: string | null;
  readonly model: string | null;
}

/** A provider-specific inference check, supplied through the composition root. */
export interface ConnectionVerifier {
  /** Complete a small request and return the model that actually answered. */
  verify(input: VerificationInput): Promise<string>;
}
