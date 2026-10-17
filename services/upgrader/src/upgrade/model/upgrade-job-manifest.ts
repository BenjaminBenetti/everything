import type { V1Job, V1Pod, V1VolumeMount } from "@kubernetes/client-node";
import type { UpgradeRequest } from "../interface/upgrade-jobs.js";

/** Labels and annotations identifying upgrade Jobs and the versions each moves between. */
export const upgradeComponent = "upgrade";
export const fromVersionAnnotation = "everything/upgrade-from";
export const toVersionAnnotation = "everything/upgrade-to";

/** Helm waits this long for the new version to become ready before rolling back. */
export const helmTimeout = "15m";
/** The Job stops after this long, leaving Helm time to roll back after its own timeout. */
export const upgradeDeadlineSeconds = 30 * 60;
/** Finished Jobs remain this long, so the outcome stays visible after the upgrade. */
const retentionSeconds = 7 * 24 * 60 * 60;

/** Where the API server mounts a pod's own service account token, which every pod gets anew. */
const serviceAccountTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount";

/** Selects the release's upgrade Jobs. */
export function upgradeJobSelector(release: string): string {
  return `app.kubernetes.io/instance=${release},app.kubernetes.io/component=${upgradeComponent}`;
}

/**
 * An upgrade Job running the upgrader's own image, account, environment, and volumes with the Job
 * entry point. It runs outside the upgrader's Deployment, which the upgrade replaces, and carries no
 * `app` label, so the upgrader's Service never routes to it.
 */
export function upgradeJobManifest(
  upgrader: V1Pod,
  request: UpgradeRequest,
  release: string,
): V1Job {
  const spec = upgrader.spec;
  const container = spec?.containers[0];
  if (!spec || !container?.image)
    throw new Error("The upgrader's pod has no container to copy");
  const mounts = (container.volumeMounts ?? []).filter(
    (mount) => !mount.mountPath.startsWith(serviceAccountTokenPath),
  );
  const mounted = new Set(mounts.map((mount: V1VolumeMount) => mount.name));
  const labels = {
    "app.kubernetes.io/instance": release,
    "app.kubernetes.io/component": upgradeComponent,
    "app.kubernetes.io/part-of":
      upgrader.metadata?.labels?.["app.kubernetes.io/part-of"] ?? release,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      generateName: `${release}-upgrade-`,
      labels,
      annotations: {
        [fromVersionAnnotation]: request.fromVersion,
        [toVersionAnnotation]: request.toVersion,
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: upgradeDeadlineSeconds,
      ttlSecondsAfterFinished: retentionSeconds,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          ...defined("serviceAccountName", spec.serviceAccountName),
          automountServiceAccountToken: true,
          ...defined("securityContext", spec.securityContext),
          containers: [
            {
              name: upgradeComponent,
              image: container.image,
              ...defined("imagePullPolicy", container.imagePullPolicy),
              command: ["node", "build/application/bootstrap/upgrade-job.js"],
              env: [
                ...(container.env ?? []).filter(
                  (variable) => variable.name !== "UPGRADE_VERSION",
                ),
                { name: "UPGRADE_VERSION", value: request.toVersion },
              ],
              ...defined("resources", container.resources),
              ...defined("securityContext", container.securityContext),
              volumeMounts: mounts,
              // Helm's error becomes the reason the upgrade failed.
              terminationMessagePolicy: "FallbackToLogsOnError",
            },
          ],
          volumes: (spec.volumes ?? []).filter((volume) =>
            mounted.has(volume.name),
          ),
        },
      },
    },
  };
}

/** A one-property object when the value is set, so optional fields stay absent rather than undefined. */
function defined<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}
