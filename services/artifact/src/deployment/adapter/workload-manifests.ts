import type {
  V1Deployment,
  V1EnvVar,
  V1PersistentVolumeClaim,
  V1PodTemplateSpec,
  V1Probe,
  V1Secret,
  V1Service,
  V1StatefulSet,
  V1Volume,
  V1VolumeMount,
} from "@kubernetes/client-node";
import { reservedEnvironmentNames } from "@everything/artifact-contracts";
import { credentialEnvironmentProblem } from "@everything/artifact-contracts/credential";
import {
  artifactLabels,
  artifactResourceName,
  credentialSecretName,
  databaseSecretName,
  diskClaimName,
  managerName,
} from "../../cluster/model/cluster-names.js";
import { credentialSecretKey } from "../../credential/adapter/kubernetes-credential-secrets.js";
import {
  credentialAnnotation,
  formatCredentialEntries,
} from "../../credential/model/credential-binding.js";
import type { DatabaseConnection } from "../../database/interface/artifact-databases.js";
import type { ArtifactWorkload } from "../interface/workload-orchestrator.js";

/** Where artifact workloads run. */
export interface WorkloadSettings {
  readonly namespace: string;
  /** Docker config Secret holding the registry pull credential, in the artifact namespace. */
  readonly pullSecret: string;
  /** Storage class for artifact disks; empty uses the cluster's default. */
  readonly storageClassName: string;
}

/** Port the artifact's Service exposes inside the cluster. */
export const servicePort = 80;

/** Container name of every artifact pod. */
export const containerName = "app";

/** Also exclude reserved names from deployments saved before a capability introduced them. */
const reserved = new Set<string>(reservedEnvironmentNames);

/** Labels selecting one artifact's objects. */
export function artifactSelector(artifactId: string): Record<string, string> {
  return {
    [artifactLabels.managedBy]: managerName,
    [artifactLabels.artifactId]: artifactId,
  };
}

/** Labels of one artifact's objects, including its slug for people reading the cluster. */
function artifactObjectLabels(
  artifactId: string,
  slug: string,
): Record<string, string> {
  return { ...artifactSelector(artifactId), [artifactLabels.slug]: slug };
}

/**
 * Credentials the pod receives. Validation already refuses reserved names and names shared with
 * ordinary variables; any that slipped through are left out rather than allowed to override.
 */
function grantedCredentials(workload: ArtifactWorkload) {
  return workload.credentials.filter(
    (credential) =>
      !credentialEnvironmentProblem(credential.env) &&
      !Object.hasOwn(workload.settings.env, credential.env),
  );
}

/**
 * Variables the artifact receives, with the service's own set last so they cannot be overridden.
 * Credentials are references to their versions' Secrets, so values never enter the manifest.
 */
function environment(workload: ArtifactWorkload): V1EnvVar[] {
  return [
    ...Object.entries(workload.settings.env)
      .filter(([name]) => !reserved.has(name))
      .map(([name, value]) => ({
        name,
        value,
      })),
    ...grantedCredentials(workload).map((credential) => ({
      name: credential.env,
      valueFrom: {
        secretKeyRef: {
          name: credentialSecretName(
            workload.artifactId,
            credential.credentialId,
            credential.version,
          ),
          key: credentialSecretKey,
        },
      },
    })),
    { name: "PORT", value: String(workload.settings.port) },
    { name: "BASE_PATH", value: `/${workload.slug}` },
  ];
}

/** Check readiness over HTTP when the artifact names a health path, else by opening its port. */
function readinessProbe(workload: ArtifactWorkload): V1Probe {
  const timing = { periodSeconds: 5, failureThreshold: 3, timeoutSeconds: 3 };
  return workload.settings.healthPath
    ? {
        httpGet: { path: workload.settings.healthPath, port: "http" },
        ...timing,
      }
    : { tcpSocket: { port: "http" }, ...timing };
}

/** The artifact's pod: unprivileged, with writable `/tmp`, and `/data` when it has a disk. */
function podTemplate(
  workload: ArtifactWorkload,
  settings: WorkloadSettings,
): V1PodTemplateSpec {
  const volumes: V1Volume[] = [{ name: "tmp", emptyDir: {} }];
  const mounts: V1VolumeMount[] = [{ name: "tmp", mountPath: "/tmp" }];
  if (workload.settings.diskGi !== null) {
    volumes.push({
      name: "data",
      persistentVolumeClaim: { claimName: diskClaimName(workload.artifactId) },
    });
    mounts.push({ name: "data", mountPath: "/data" });
  }
  return {
    metadata: {
      labels: artifactObjectLabels(workload.artifactId, workload.slug),
      annotations: {
        "everything.dev/release": String(workload.release),
        ...(workload.capabilities.fingerprint
          ? { "everything.dev/capabilities": workload.capabilities.fingerprint }
          : {}),
        ...(workload.databaseFingerprint
          ? { "everything.dev/database-password": workload.databaseFingerprint }
          : {}),
        // Identifiers only: lets the service observe which credential versions each pod holds.
        ...(grantedCredentials(workload).length
          ? {
              [credentialAnnotation]: formatCredentialEntries(
                grantedCredentials(workload),
              ),
            }
          : {}),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      imagePullSecrets: [{ name: settings.pullSecret }],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: containerName,
          image: workload.image,
          imagePullPolicy: "IfNotPresent",
          ports: [{ name: "http", containerPort: workload.settings.port }],
          env: environment(workload),
          ...(workload.settings.database ||
          workload.capabilities.secretNames.length
            ? {
                envFrom: [
                  ...(workload.settings.database
                    ? [databaseSecretName(workload.artifactId)]
                    : []),
                  ...workload.capabilities.secretNames,
                ].map((name) => ({ secretRef: { name } })),
              }
            : {}),
          readinessProbe: readinessProbe(workload),
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "50m", memory: "128Mi" },
            limits: { cpu: "1", memory: "512Mi" },
          },
          volumeMounts: mounts,
        },
      ],
      volumes,
    },
  };
}

/** A stateless artifact's Deployment, rolling to a new pod before stopping the old one. */
export function deploymentManifest(
  workload: ArtifactWorkload,
  settings: WorkloadSettings,
): V1Deployment {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: artifactResourceName(workload.artifactId),
      namespace: settings.namespace,
      labels: artifactObjectLabels(workload.artifactId, workload.slug),
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: artifactSelector(workload.artifactId) },
      template: podTemplate(workload, settings),
    },
  };
}

/** An artifact with a disk runs as a one-replica StatefulSet, so two pods never share the disk. */
export function statefulSetManifest(
  workload: ArtifactWorkload,
  settings: WorkloadSettings,
): V1StatefulSet {
  const name = artifactResourceName(workload.artifactId);
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: {
      name,
      namespace: settings.namespace,
      labels: artifactObjectLabels(workload.artifactId, workload.slug),
    },
    spec: {
      replicas: 1,
      serviceName: name,
      selector: { matchLabels: artifactSelector(workload.artifactId) },
      template: podTemplate(workload, settings),
    },
  };
}

/** The Service the artifact service forwards requests to. */
export function serviceManifest(
  workload: ArtifactWorkload,
  settings: WorkloadSettings,
): V1Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: artifactResourceName(workload.artifactId),
      namespace: settings.namespace,
      labels: artifactObjectLabels(workload.artifactId, workload.slug),
    },
    spec: {
      selector: artifactSelector(workload.artifactId),
      ports: [{ name: "http", port: servicePort, targetPort: "http" }],
    },
  };
}

/** The artifact's disk, which outlives stops and redeployments. */
export function diskClaimManifest(
  workload: ArtifactWorkload,
  sizeGi: number,
  settings: WorkloadSettings,
): V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: diskClaimName(workload.artifactId),
      namespace: settings.namespace,
      labels: artifactObjectLabels(workload.artifactId, workload.slug),
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      ...(settings.storageClassName
        ? { storageClassName: settings.storageClassName }
        : {}),
      resources: { requests: { storage: `${sizeGi}Gi` } },
    },
  };
}

/** The artifact's database connection, as a URL and as standard libpq variables. */
export function databaseSecretManifest(
  artifactId: string,
  connection: DatabaseConnection,
  settings: WorkloadSettings,
): V1Secret {
  const url = `postgresql://${connection.user}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
  const values: Record<string, string> = {
    DATABASE_URL: url,
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGDATABASE: connection.database,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
  };
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: databaseSecretName(artifactId),
      namespace: settings.namespace,
      labels: artifactSelector(artifactId),
    },
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        Buffer.from(value).toString("base64"),
      ]),
    ),
  };
}
