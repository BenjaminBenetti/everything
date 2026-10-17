import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";

/** The chart the upgrader upgrades, rendered as the installer and cluster:up render it. */
const chart = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../deployment/helm",
);
const namespace = "everything";

/** The API group and resource of each kind the chart renders, and whether it is namespaced. */
const kinds: Record<
  string,
  { group: string; resource: string; namespaced: boolean }
> = {
  ConfigMap: { group: "", resource: "configmaps", namespaced: true },
  Deployment: { group: "apps", resource: "deployments", namespaced: true },
  Ingress: {
    group: "networking.k8s.io",
    resource: "ingresses",
    namespaced: true,
  },
  PersistentVolumeClaim: {
    group: "",
    resource: "persistentvolumeclaims",
    namespaced: true,
  },
  Role: {
    group: "rbac.authorization.k8s.io",
    resource: "roles",
    namespaced: true,
  },
  RoleBinding: {
    group: "rbac.authorization.k8s.io",
    resource: "rolebindings",
    namespaced: true,
  },
  Secret: { group: "", resource: "secrets", namespaced: true },
  Service: { group: "", resource: "services", namespaced: true },
  ServiceAccount: { group: "", resource: "serviceaccounts", namespaced: true },
  StatefulSet: { group: "apps", resource: "statefulsets", namespaced: true },
  ClusterRole: {
    group: "rbac.authorization.k8s.io",
    resource: "clusterroles",
    namespaced: false,
  },
  ClusterRoleBinding: {
    group: "rbac.authorization.k8s.io",
    resource: "clusterrolebindings",
    namespaced: false,
  },
  Namespace: { group: "", resource: "namespaces", namespaced: false },
};

/** One RBAC rule. */
interface Rule {
  readonly apiGroups?: string[];
  readonly resources?: string[];
  readonly verbs: string[];
}

/** A rendered object, as far as these checks read it. */
interface Manifest {
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly annotations?: Record<string, string>;
  };
  readonly rules?: Rule[];
}

/** Render the chart with the given values files from the chart's directory. */
async function render(...values: string[]): Promise<Manifest[]> {
  const { stdout } = await promisify(execFile)(
    "helm",
    [
      "template",
      "everything",
      chart,
      "--namespace",
      namespace,
      ...values.flatMap((file) => ["--values", path.join(chart, file)]),
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return parseAllDocuments(stdout)
    .map((document) => document.toJS() as Manifest | null)
    .filter((manifest): manifest is Manifest => manifest !== null);
}

/** Whether a rule allows a verb on a resource of a group. */
function allows(
  rule: Rule,
  group: string,
  resource: string,
  verb: string,
): boolean {
  const matches = (values: string[] | undefined, value: string) =>
    !!values && (values.includes(value) || values.includes("*"));
  return (
    matches(rule.apiGroups, group) &&
    matches(rule.resources, resource) &&
    matches(rule.verbs, verb)
  );
}

for (const values of [
  ["values.dev.yaml"],
  ["values.dev.yaml", "values.prod.yaml"],
])
  test(`the upgrader can manage everything the chart renders, and grant what it grants (${values.join(", ")})`, async () => {
    const manifests = await render(...values);
    const upgraderRoles = new Map(
      manifests
        .filter(
          (manifest) =>
            manifest.kind === "Role" &&
            manifest.metadata.name === "everything-upgrader",
        )
        .map((role) => [role.metadata.namespace!, role.rules ?? []]),
    );
    const upgraderCluster =
      manifests.find(
        (manifest) =>
          manifest.kind === "ClusterRole" &&
          manifest.metadata.name === "everything-upgrader",
      )?.rules ?? [];
    /** The upgrader's rules in a namespace, or cluster-wide for an empty one. */
    const rulesIn = (scope: string) => [
      ...(scope ? (upgraderRoles.get(scope) ?? []) : []),
      ...upgraderCluster,
    ];
    const missing: string[] = [];

    for (const manifest of manifests) {
      const kind = kinds[manifest.kind];
      if (!kind) {
        missing.push(
          `${manifest.kind} is not a kind the upgrader's rules cover`,
        );
        continue;
      }
      const scope = kind.namespaced
        ? (manifest.metadata.namespace ?? namespace)
        : "";
      const kept =
        manifest.metadata.annotations?.["helm.sh/resource-policy"] === "keep";
      for (const verb of [
        "get",
        "list",
        "watch",
        "create",
        "update",
        "patch",
        ...(kept ? [] : ["delete"]),
      ])
        if (
          !rulesIn(scope).some((rule) =>
            allows(rule, kind.group, kind.resource, verb),
          )
        )
          missing.push(
            `${verb} ${manifest.kind} ${manifest.metadata.name} in ${scope || "the cluster"}`,
          );
    }

    // Kubernetes lets an account create a Role only with permissions it holds itself.
    for (const role of manifests.filter(
      (manifest) => manifest.kind === "Role" || manifest.kind === "ClusterRole",
    )) {
      const scope = role.kind === "Role" ? role.metadata.namespace! : "";
      for (const rule of role.rules ?? [])
        for (const group of rule.apiGroups ?? [])
          for (const resource of rule.resources ?? [])
            for (const verb of rule.verbs)
              if (
                !rulesIn(scope).some((held) =>
                  allows(held, group, resource, verb),
                )
              )
                missing.push(
                  `${verb} ${group || "core"}/${resource} in ${scope || "the cluster"}, granted by ${role.metadata.name}`,
                );
    }

    // Helm's release records, and the upgrader's own Jobs and caller checks.
    for (const [group, resource, verb, scope] of [
      ["", "secrets", "delete", namespace],
      ["batch", "jobs", "create", namespace],
      ["", "pods", "watch", namespace],
      ["apps", "replicasets", "watch", namespace],
      ["authentication.k8s.io", "tokenreviews", "create", ""],
    ] as const)
      if (!rulesIn(scope).some((rule) => allows(rule, group, resource, verb)))
        missing.push(
          `${verb} ${group || "core"}/${resource} in ${scope || "the cluster"}`,
        );

    assert.deepEqual(missing, []);
  });

test("the upgrader holds no access beyond the namespaces and kinds the chart uses", async () => {
  const manifests = await render("values.dev.yaml", "values.prod.yaml");
  const roles = manifests.filter(
    (manifest) =>
      (manifest.kind === "Role" || manifest.kind === "ClusterRole") &&
      manifest.metadata.name.endsWith("-upgrader"),
  );
  assert.deepEqual(
    roles
      .filter((role) => role.kind === "Role")
      .map((role) => role.metadata.namespace)
      .sort(),
    [
      "everything",
      "everything-artifacts",
      "everything-builds",
      "everything-fleet",
    ],
  );
  for (const role of roles)
    for (const rule of role.rules ?? []) {
      assert.ok(
        !rule.verbs.includes("*"),
        `${role.metadata.name} grants every verb`,
      );
      assert.ok(
        !rule.resources?.includes("*"),
        `${role.metadata.name} grants every resource`,
      );
      assert.ok(
        !rule.verbs.some(
          (verb) =>
            verb === "escalate" || verb === "bind" || verb === "impersonate",
        ),
        `${role.metadata.name} grants a verb that bypasses RBAC`,
      );
    }
});
