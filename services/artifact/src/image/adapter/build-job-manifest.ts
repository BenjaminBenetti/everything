import { posix } from "node:path";
import type { V1Job } from "@kubernetes/client-node";
import {
  artifactLabels,
  buildJobName,
  managerName,
} from "../../cluster/model/cluster-names.js";
import type { BuildJob } from "../interface/build-runner.js";

/** Where and how build jobs run. */
export interface BuildkitSettings {
  /** Namespace whose Pod Security policy allows rootless BuildKit. */
  readonly namespace: string;
  /** Rootless BuildKit image, such as `moby/buildkit:v0.33.1-rootless`. */
  readonly image: string;
  /** Docker config Secret holding the registry push credential, in the build namespace. */
  readonly pushSecret: string;
}

/** Longest a build may run before Kubernetes stops it. */
export const buildDeadlineSeconds = 30 * 60;

/** Directory where the source is unpacked inside the build pod. */
const contextDirectory = "/source/context";

/** Describe the Job that downloads a build's source, builds its image, and pushes it. */
export function buildJobManifest(
  job: BuildJob,
  settings: BuildkitSettings,
): V1Job {
  const labels = {
    [artifactLabels.managedBy]: managerName,
    [artifactLabels.artifactId]: job.artifactId,
    [artifactLabels.buildId]: job.buildId,
  };
  const dockerfileDirectory = posix.join(
    contextDirectory,
    posix.dirname(job.dockerfile),
  );
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: buildJobName(job.buildId),
      namespace: settings.namespace,
      labels,
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: buildDeadlineSeconds,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          initContainers: [
            {
              name: "source",
              image: settings.image,
              command: ["sh", "-c"],
              // Download first, so a failed download fails the step instead of unpacking nothing.
              args: [
                'wget -q -O /source/source.tar "$SOURCE_URL" && mkdir -p /source/context && tar -x -f /source/source.tar -C /source/context && rm /source/source.tar',
              ],
              env: [{ name: "SOURCE_URL", value: job.sourceUrl }],
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                seccompProfile: { type: "RuntimeDefault" },
              },
              volumeMounts: [{ name: "source", mountPath: "/source" }],
            },
          ],
          containers: [
            {
              name: "buildkit",
              image: settings.image,
              command: ["buildctl-daemonless.sh"],
              args: [
                "build",
                "--frontend=dockerfile.v0",
                `--local=context=${contextDirectory}`,
                `--local=dockerfile=${dockerfileDirectory}`,
                `--opt=filename=${posix.basename(job.dockerfile)}`,
                ...Object.entries(job.buildArgs).map(
                  ([name, value]) => `--opt=build-arg:${name}=${value}`,
                ),
                // The registry is reached over plain HTTP inside the cluster.
                `--output=type=image,name=${job.image},push=true,registry.insecure=true`,
              ],
              env: [
                // Rootless BuildKit without a process sandbox runs under the namespace's relaxed policy.
                {
                  name: "BUILDKITD_FLAGS",
                  value: "--oci-worker-no-process-sandbox",
                },
                { name: "DOCKER_CONFIG", value: "/docker" },
              ],
              securityContext: {
                seccompProfile: { type: "Unconfined" },
                appArmorProfile: { type: "Unconfined" },
              },
              resources: {
                requests: { cpu: "250m", memory: "512Mi" },
                limits: { cpu: "2", memory: "2Gi" },
              },
              volumeMounts: [
                { name: "source", mountPath: "/source" },
                {
                  name: "state",
                  mountPath: "/home/user/.local/share/buildkit",
                },
                { name: "docker", mountPath: "/docker", readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: "source", emptyDir: {} },
            { name: "state", emptyDir: {} },
            {
              name: "docker",
              secret: {
                secretName: settings.pushSecret,
                items: [{ key: ".dockerconfigjson", path: "config.json" }],
              },
            },
          ],
        },
      },
    },
  };
}
