import type { ArtifactDetails } from "@everything/artifact-contracts";
import type {
  AppCredentialGrant,
  CredentialAppUse,
  CredentialDelivery,
  CredentialInventoryEntry,
  CredentialValueInput,
} from "@everything/artifact-contracts/credential";
import type { ArtifactActor } from "../../artifact/interface/artifact-gateway.js";

/** The app service's credential endpoints, as Everything uses them. */
export interface CredentialGateway {
  /** Give one of the owner's dynamic apps a credential. */
  attachCredential(
    actor: ArtifactActor,
    reference: string,
    grant: AppCredentialGrant,
  ): Promise<ArtifactDetails>;
  /** Take a credential away from one of the owner's apps. */
  detachCredential(
    actor: ArtifactActor,
    reference: string,
    env: string,
  ): Promise<ArtifactDetails>;
  /** Deliver a credential's new value to every app that receives it. */
  deliverCredential(
    credentialId: string,
    input: CredentialValueInput,
  ): Promise<CredentialDelivery>;
  /** Revoke a deleted credential from every app. */
  revokeCredential(credentialId: string): Promise<CredentialDelivery>;
  /** Every app, of any owner, that receives or still holds a credential. */
  credentialUses(credentialId: string): Promise<CredentialAppUse[]>;
  /** Every credential the app service knows of, for synchronization. */
  credentialInventory(): Promise<CredentialInventoryEntry[]>;
}
