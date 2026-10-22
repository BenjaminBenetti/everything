import type {
  ArtifactDeploymentSettings,
  ArtifactRuntime,
} from "@everything/artifact-contracts";
import type { DatabaseConnection } from "../../database/interface/artifact-databases.js";
import type { CapabilityEnvironment } from "../../capability/interface/artifact-capabilities.js";
import type { CredentialEntry } from "../../credential/model/credential-binding.js";
import type { PodCredentials } from "../../credential/model/credential-status.js";

/** Everything needed to run one dynamic artifact. */
export interface ArtifactWorkload {
  readonly artifactId: string;
  readonly slug: string;
  /** Image reference by digest, as nodes pull it. */
  readonly image: string;
  readonly settings: ArtifactDeploymentSettings;
  /** Live release number; a change restarts the pod. */
  readonly release: number;
  /** Short fingerprint of the database password, so a changed password restarts the pod. */
  readonly databaseFingerprint: string | null;
  /** References to capability credentials, including a fingerprint that triggers credential rollouts. */
  readonly capabilities: CapabilityEnvironment;
  /** Granted credentials, each read from its version's Secret; values never enter the manifest. */
  readonly credentials: readonly CredentialEntry[];
}

/** Which container output to read. */
export interface LogOptions {
  /** Read the container that ran before the latest restart. */
  readonly previous: boolean;
  readonly lines: number;
}

/** Runs dynamic artifacts as Kubernetes workloads. */
export interface WorkloadOrchestrator {
  /** Create or update the artifact's workload and Service. */
  apply(workload: ArtifactWorkload): Promise<void>;
  /** Remove the artifact's workload, keeping its Service, Secret, and disk. */
  stop(artifactId: string): Promise<void>;
  /** Remove every Kubernetes object of the artifact, including its disk. */
  remove(artifactId: string): Promise<void>;
  /** Runtime of every artifact that has pods, by artifact ID. */
  runtimes(): Promise<ReadonlyMap<string, ArtifactRuntime>>;
  /**
   * Credentials held by each pod whose processes may still run, including pods being deleted, by
   * artifact ID; of one artifact, or of every artifact when omitted.
   */
  heldCredentials(
    artifactId?: string,
  ): Promise<ReadonlyMap<string, readonly PodCredentials[]>>;
  /** Recent output of the artifact's container. */
  logs(artifactId: string, options: LogOptions): Promise<string>;
  /** The password stored in the artifact's database Secret, if the Secret exists. */
  databasePassword(artifactId: string): Promise<string | undefined>;
  /** Store the artifact's database connection in its Secret. */
  writeDatabaseSecret(
    artifactId: string,
    connection: DatabaseConnection,
  ): Promise<void>;
}
