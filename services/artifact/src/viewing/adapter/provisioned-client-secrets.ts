import type { CapabilitySecretReader } from "../../capability/interface/capability-secret-reader.js";
import type { DeploymentRepository } from "../../deployment/interface/deployment-repository.js";
import { AppResponseBlockedError } from "../error/app-response-blocked-error.js";
import type {
  ArtifactResponseSecrets,
  ResponseSecretOwner,
} from "../interface/artifact-response-secrets.js";

/** Find each app's own client secret and fail closed when expected credentials are unavailable. */
export class ProvisionedClientSecrets implements ArtifactResponseSecrets {
  // ===========================================
  // Construction
  // ===========================================

  /** Bind release metadata and a read-only view of provisioned environments. */
  constructor(
    private readonly deployments: Pick<DeploymentRepository, "findByRelease">,
    private readonly secrets: CapabilitySecretReader,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Include credentials present during reconciliation, even before release metadata changes. */
  async read(artifact: ResponseSecretOwner): Promise<readonly string[]> {
    try {
      if (artifact.liveDeployment === null) throw new AppResponseBlockedError();
      const [deployment, environment] = await Promise.all([
        this.deployments.findByRelease(
          { ownerId: artifact.ownerId, artifactId: artifact.id },
          artifact.liveDeployment,
        ),
        this.secrets.read(artifact.id, "everything-api"),
      ]);
      if (!deployment) throw new AppResponseBlockedError();
      const secret = environment?.EVERYTHING_CLIENT_SECRET;
      if (secret) return [secret];
      if (environment || deployment.capabilities.includes("everything-api")) {
        throw new AppResponseBlockedError();
      }
      return [];
    } catch {
      // Adapter errors can contain response data. Never propagate them to request logs.
      throw new AppResponseBlockedError();
    }
  }
}
