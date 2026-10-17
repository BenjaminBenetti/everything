import type { AuthenticationV1Api } from "@kubernetes/client-node";
import type { Identity } from "@everything/security/identity";
import type { TokenVerifier } from "@everything/security/token-verifier";

/** The one caller the API accepts: a service account's token minted for this service's audience. */
export interface CallerPolicy {
  readonly audience: string;
  /** The caller's username, `system:serviceaccount:<namespace>:<name>`. */
  readonly username: string;
}

/**
 * Verifies service account tokens with the Kubernetes API's TokenReview, accepting only the allowed
 * account's tokens for this service's audience. Tokens minted for this audience are valid nowhere
 * else, and pods without the allowed account, such as teammates' workspaces, cannot obtain one.
 */
export class KubernetesTokenVerifier implements TokenVerifier {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind the TokenReview API and the caller policy. */
  constructor(
    private readonly reviews: Pick<AuthenticationV1Api, "createTokenReview">,
    private readonly policy: CallerPolicy,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Ask the API server whether the token is the allowed caller's, for this audience. */
  async verify(token: string): Promise<Identity> {
    const review = await this.reviews.createTokenReview({
      body: {
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenReview",
        spec: { token, audiences: [this.policy.audience] },
      },
    });
    const status = review.status;
    if (
      status?.authenticated !== true ||
      status.user?.username !== this.policy.username ||
      !status.audiences?.includes(this.policy.audience)
    )
      throw new Error("The token is not the allowed caller's");
    return { subject: this.policy.username };
  }
}
