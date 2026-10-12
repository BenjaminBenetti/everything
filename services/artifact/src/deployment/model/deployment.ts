import type { OwnedEntity } from "@everything/persistence/entity";
import type {
  ArtifactAuthor,
  ArtifactDeploymentSettings,
} from "@everything/artifact-contracts";

/** Number of deployments kept per artifact; the live deployment is always kept. */
export const deploymentRetention = 20;

/** A release of a dynamic artifact: one build with its runtime settings. */
export interface Deployment extends OwnedEntity, ArtifactDeploymentSettings {
  readonly artifactId: string;
  readonly release: number;
  readonly author: ArtifactAuthor;
  readonly build: number;
  readonly imageDigest: string;
}

/** Stored columns of a deployment, with its author flattened. */
export interface DeploymentRecord extends Omit<Deployment, "author"> {
  readonly authorId: string;
  readonly authorName: string;
}

/** A new deployment's release, build, and settings. */
export type NewDeployment = Omit<
  Deployment,
  "id" | "ownerId" | "artifactId" | "createdAt"
>;
