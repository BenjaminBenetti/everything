import type { Identity } from "../model/identity.js";

/** Authentication contract independent of a provider or HTTP framework. */
export interface TokenVerifier {
  /** Verify a bearer access token and return its authenticated subject. */
  verify(token: string): Promise<Identity>;
}
