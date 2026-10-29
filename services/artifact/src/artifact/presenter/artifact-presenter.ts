import type { AppCredentialView } from "../../credential/service/app-credentials.js";
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
    return artifact.liveRevision === null
      ? "unpublished"
      : artifact.running
        ? "live"
        : "stopped";
  if (artifact.liveDeployment === null) return "unpublished";
  return runtime?.state ?? "stopped";
}

/** The origins an app's links are built on: the artifact host and the public apps host. */
export interface HostOrigins {
  readonly artifact: string;
  readonly publicApps: string;
}

/** Present an artifact with its status, current capability flags, and credential metadata. */
export function representSummary(
  artifact: Artifact,
  observed: ArtifactRuntime | undefined,
  origins: HostOrigins,
  deployment: Pick<ArtifactDeployment, "database" | "capabilities"> | undefined,
  credentials: AppCredentialView | undefined,
): ArtifactSummary {
  return {
    id: artifact.id,
    slug: artifact.slug,
    kind: artifact.kind,
    title: artifact.title,
    description: artifact.description,
    database: deployment?.database ?? false,
    capabilities: deployment?.capabilities ?? [],
    credentials:
      artifact.kind === "dynamic" ? (credentials?.credentials ?? []) : [],
    credentialGeneration: credentials?.generation ?? 0,
    url: `${origins.artifact}/${artifact.slug}/`,
    publicUrl: `${origins.publicApps}/${artifact.slug}/`,
    visibility: artifact.visibility,
    status: statusOf(artifact, runtimeOf(artifact, observed)),
    release: artifact.release,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    createdBy: artifact.createdBy,
    updatedBy: artifact.updatedBy,
  };
}

/** Present an artifact with its recent history, live release, runtime, and credentials. */
export function representDetails(
  artifact: Artifact,
  history: ArtifactHistory,
  observed: ArtifactRuntime | undefined,
  origins: HostOrigins,
  credentials: AppCredentialView | undefined,
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
        capabilities: history.deployment.capabilities,
        diskGi: history.deployment.diskGi,
        healthPath: history.deployment.healthPath,
      }
    : null;
  return {
    ...representSummary(
      artifact,
      observed,
      origins,
      history.deployment,
      credentials,
    ),
    liveRevision: artifact.liveRevision,
    revisions: history.revisions,
    builds: history.builds,
    deployment,
    runtime: runtimeOf(artifact, observed),
  };
}
