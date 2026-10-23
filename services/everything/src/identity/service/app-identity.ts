import type { Identity } from "@everything/security/identity";
import {
  everythingAppClaims,
  everythingAppClientId,
  everythingAppClientPrefix,
} from "@everything/artifact-contracts/everything-api";

/** Resolve provisioned app tokens to their owner only after signature, issuer, and audience checks. */
export function appIdentity(
  identity: Identity,
  claims: Readonly<Record<string, unknown>>,
): Identity {
  const owner = claims[everythingAppClaims.owner];
  const app = claims[everythingAppClaims.app];
  const client = claims.azp;
  const appClient =
    typeof client === "string" && client.startsWith(everythingAppClientPrefix);
  if (!appClient && owner === undefined && app === undefined) return identity;
  if (
    typeof owner !== "string" ||
    !owner.trim() ||
    typeof app !== "string" ||
    client !== everythingAppClientId(app)
  )
    throw new Error("Invalid app identity");
  return { subject: owner, app };
}
