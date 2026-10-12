/** Field manager and `managed-by` label value for every Kubernetes object this service writes. */
export const managerName = "everything-artifact";

/** Labels identifying the Kubernetes objects of one artifact or build. */
export const artifactLabels = {
  managedBy: "app.kubernetes.io/managed-by",
  artifactId: "everything.dev/artifact-id",
  slug: "everything.dev/artifact-slug",
  buildId: "everything.dev/build-id",
} as const;

/** A UUID without hyphens, which keeps derived names short and valid in Kubernetes and PostgreSQL. */
function compact(id: string): string {
  const value = id.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(value)) throw new Error("Expected a UUID");
  return value;
}

/** Name of an artifact's workload and Service. */
export function artifactResourceName(artifactId: string): string {
  return `artifact-${compact(artifactId)}`;
}

/** Name of the Secret holding an artifact's database connection. */
export function databaseSecretName(artifactId: string): string {
  return `${artifactResourceName(artifactId)}-database`;
}

/** Name of the persistent volume claim mounted at an artifact's `/data`. */
export function diskClaimName(artifactId: string): string {
  return `${artifactResourceName(artifactId)}-data`;
}

/** PostgreSQL role and schema of an artifact; both share this name. */
export function databaseRoleName(artifactId: string): string {
  return `artifact_${compact(artifactId)}`;
}

/** Name of the Job that runs one build. */
export function buildJobName(buildId: string): string {
  return `build-${compact(buildId)}`;
}

/** Registry repository holding an artifact's images. */
export function imageRepository(artifactId: string): string {
  return `artifacts/${compact(artifactId)}`;
}

/** Registry tag of one build's image. */
export function imageTag(buildNumber: number): string {
  return `build-${buildNumber}`;
}
