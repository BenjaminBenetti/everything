import type {
  ArtifactDeploymentSettings,
  ArtifactRuntime,
} from "@everything/artifact-contracts";
import type { DatabaseConnection } from "../../database/interface/artifact-databases.js";

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
