import type { Artifact } from "../../artifact/model/artifact.js";

/** App identity and release needed to locate its provisioned credentials. */
export type ResponseSecretOwner = Pick<
  Artifact,
  "id" | "ownerId" | "liveDeployment"
>;

/** Credentials that must never leave this app through the public proxy. */
export interface ArtifactResponseSecrets {
  /** Load the app's credentials, rejecting when protection cannot be established. */
  read(artifact: ResponseSecretOwner): Promise<readonly string[]>;
}
