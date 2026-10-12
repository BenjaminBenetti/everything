import type {
  ArtifactBuild,
  ArtifactDeployment,
  ArtifactDetails,
  ArtifactRevision,
  ArtifactRuntime,
  ArtifactStatus,
  ArtifactSummary,
} from "@everything/artifact-contracts";
import type { Deployment } from "../../deployment/model/deployment.js";
import type { Artifact } from "../model/artifact.js";

/** History and runtime shown with an artifact's details. */
export interface ArtifactHistory {
  readonly revisions: readonly ArtifactRevision[];
  readonly builds: readonly ArtifactBuild[];
  readonly deployment: Deployment | undefined;
}

/** Runtime of a dynamic artifact: stopped unless its live deployment should run. */
function runtimeOf(
  artifact: Artifact,
  observed: ArtifactRuntime | undefined,
): ArtifactRuntime | null {
  if (artifact.kind === "static") return null;
  if (!artifact.running || artifact.liveDeployment === null)
    return { state: "stopped", restarts: 0, reason: null };
  return observed ?? { state: "starting", restarts: 0, reason: null };
}

/** What a viewer would see now. */
function statusOf(
  artifact: Artifact,
  runtime: ArtifactRuntime | null,
): ArtifactStatus {
  if (artifact.kind === "static")
    return artifact.liveRevision === null ? "unpublished" : "live";
  if (artifact.liveDeployment === null) return "unpublished";
  return runtime?.state ?? "stopped";
}

/** Present an artifact as listed, with its link on the artifact host and its status. */
export function representSummary(
  artifact: Artifact,
  observed: ArtifactRuntime | undefined,
  artifactOrigin: string,
): ArtifactSummary {
  return {
    id: artifact.id,
    slug: artifact.slug,
    kind: artifact.kind,
    title: artifact.title,
    description: artifact.description,
    url: `${artifactOrigin}/${artifact.slug}/`,
    status: statusOf(artifact, runtimeOf(artifact, observed)),
    release: artifact.release,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    createdBy: artifact.createdBy,
    updatedBy: artifact.updatedBy,
  };
}

/** Present an artifact with its recent history, live release, and runtime. */
export function representDetails(
  artifact: Artifact,
  history: ArtifactHistory,
  observed: ArtifactRuntime | undefined,
  artifactOrigin: string,
): ArtifactDetails {
  const deployment: ArtifactDeployment | null = history.deployment
    ? {
        release: history.deployment.release,
        createdAt: history.deployment.createdAt,
        author: history.deployment.author,
        build: history.deployment.build,
        port: history.deployment.port,
        env: history.deployment.env,
        database: history.deployment.database,
        diskGi: history.deployment.diskGi,
        healthPath: history.deployment.healthPath,
      }
    : null;
  return {
    ...representSummary(artifact, observed, artifactOrigin),
    liveRevision: artifact.liveRevision,
    revisions: history.revisions,
    builds: history.builds,
    deployment,
    runtime: runtimeOf(artifact, observed),
  };
}
