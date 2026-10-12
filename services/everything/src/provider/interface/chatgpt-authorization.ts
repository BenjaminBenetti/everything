import type { ProviderAuthorization } from "@everything/provider-contracts";
import type {
  PendingAuthorization,
  ProviderCredential,
} from "../model/stored-provider.js";

/** OAuth mechanics are independent of persistence and HTTP controllers. */
export interface ChatGptAuthorization {
  /** Create a new attempt using the saved host and registration where available. */
  begin(credential: ProviderCredential): {
    credential: ProviderCredential;
    pending: PendingAuthorization;
    authorization: ProviderAuthorization;
  };
  /** Validate a callback and persist its issued registration before exchanging the code. */
  complete(
    credential: ProviderCredential,
    pending: PendingAuthorization,
    callback: string,
    retainRegistration: (credential: ProviderCredential) => Promise<void>,
  ): Promise<{ credential: ProviderCredential; account: string }>;
  /** Refresh near expiry; callers persist the returned tokens before further requests. */
  refresh(credential: ProviderCredential): Promise<ProviderCredential>;
  /** Revoke the renewable session, returning false if revocation could not be confirmed. */
  revoke(credential: ProviderCredential): Promise<boolean>;
}
