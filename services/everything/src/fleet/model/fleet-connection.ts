import type { FleetSettings } from "./fleet-settings.js";

/** Name of the cluster connection Everything gives Fleet, and of its kubeconfig context. */
export const connectionName = "everything";

/** Everything's connection as `fleet cluster ls --json` reports it. */
export interface ConnectionRecord {
  readonly display_name?: string;
  /** Whether instance pods may run privileged; unset lets Fleet decide by the kind of cluster. */
  readonly allow_privileged?: boolean;
}

/** Find Everything's connection in the output of `fleet cluster ls --json`. */
export function findConnection(listing: string): ConnectionRecord | undefined {
  const parsed = JSON.parse(listing) as {
    readonly clusters?: readonly { readonly cluster?: ConnectionRecord }[];
  };
  return (parsed.clusters ?? [])
    .map((status) => status.cluster)
    .find((cluster) => cluster?.display_name === connectionName);
}

/** The `fleet cluster set` argument that allows or forbids privileged workers. */
export function privilegedField(privileged: boolean): string {
  return `allow_privileged=${privileged}`;
}

/** Credentials of the pod's service account, which Kubernetes mounts and rotates. */
const serviceAccount = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * A kubeconfig for the cluster Everything runs in, authenticated as Everything's service account.
 * fleetd connects through kubeconfig contexts only; naming the token file rather than copying the
 * token lets it pick up each rotation.
 */
export function inClusterKubeconfig(namespace: string): object {
  return {
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: connectionName,
        cluster: {
          server: "https://kubernetes.default.svc",
          "certificate-authority": `${serviceAccount}/ca.crt`,
        },
      },
    ],
    users: [
      {
        name: connectionName,
        user: { tokenFile: `${serviceAccount}/token` },
      },
    ],
    contexts: [
      {
        name: connectionName,
        context: { cluster: connectionName, user: connectionName, namespace },
      },
    ],
    "current-context": connectionName,
  };
}

/**
 * A Docker configuration holding the registry login, keeping anything else already in it. Docker
 * pushes Fleet's images with the login, and Fleet builds the pull Secret nodes use from it.
 */
export function dockerConfigWithLogin(
  existing: Readonly<Record<string, unknown>>,
  registry: FleetSettings["registry"],
): Record<string, unknown> {
  const auths =
    typeof existing.auths === "object" && existing.auths !== null
      ? (existing.auths as Record<string, unknown>)
      : {};
  const auth = Buffer.from(
    `${registry.username}:${registry.password}`,
  ).toString("base64");
  return { ...existing, auths: { ...auths, [registry.host]: { auth } } };
}

/**
 * The connection settings Everything's chart manages, as the `field=value` arguments of `fleet
 * cluster add` and `fleet cluster set`. Whether workers run privileged is the user's setting; Fleet
 * keeps every other setting at its default or as a user set it.
 */
export function connectionFields(settings: FleetSettings): readonly string[] {
  return [
    // Fleet pushes the images it builds to the stack's registry, and nodes pull them from the same
    // address.
    "image.mode=registry",
    `image.registry=${settings.registry.host}`,
    `image.insecure_registry=${settings.registry.insecure}`,
    // An empty storage class resets the field, letting Fleet choose.
    `storage_class=${settings.storageClass}`,
  ];
}
