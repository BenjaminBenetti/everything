import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";

/** The chart, rendered as cluster:up and the installers render it. */
const chart = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../deployment/helm",
);

/** A rendered object, as far as these checks read it. */
interface Manifest {
  readonly kind: string;
  readonly metadata: { readonly name: string };
  readonly data?: Record<string, string>;
  readonly spec?: Record<string, unknown>;
}

/** One container's settings, as the checks read them. */
interface Container {
  readonly image: string;
  readonly env: { name: string; value?: string; valueFrom?: unknown }[];
  readonly securityContext: Record<string, unknown>;
  readonly volumeMounts: { name: string; mountPath: string }[];
  readonly resources: { limits: Record<string, string> };
}

/** Render the chart with the development values and `settings`. */
async function render(...settings: string[]): Promise<Manifest[]> {
  const { stdout } = await promisify(execFile)(
    "helm",
    [
      "template",
      "everything",
      chart,
      "--namespace",
      "everything",
      "--values",
      path.join(chart, "values.dev.yaml"),
      ...settings.flatMap((setting) => ["--set", setting]),
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return parseAllDocuments(stdout)
    .map((document) => document.toJS() as Manifest | null)
    .filter((manifest): manifest is Manifest => manifest !== null);
}

/** A workload's main container and pod spec. */
function workload(manifests: Manifest[], name: string) {
  const found = manifests.find(
    (manifest) =>
      manifest.kind === "StatefulSet" && manifest.metadata.name === name,
  );
  if (!found) return undefined;
  const pod = (found.spec!.template as { spec: Record<string, unknown> }).spec;
  return {
    pod,
    container: (pod.containers as Container[])[0]!,
  };
}

/** A container's literal settings. */
function environment(container: Container): Record<string, string> {
  return Object.fromEntries(
    container.env
      .filter((variable) => variable.value !== undefined)
      .map((variable) => [variable.name, variable.value!]),
  );
}

test("OpenObserve runs pinned, non-root, inside the cluster only, with seven days of retention and no outside connections", async () => {
  const manifests = await render();
  const openobserve = workload(manifests, "openobserve");
  assert.ok(openobserve, "the chart renders OpenObserve");
  const { container, pod } = openobserve;
  assert.match(
    container.image,
    /^docker\.io\/openobserve\/openobserve:v[0-9.]+@sha256:[0-9a-f]{64}$/,
  );
  const settings = environment(container);
  assert.equal(settings.ZO_COMPACT_DATA_RETENTION_DAYS, "7");
  assert.equal(settings.ZO_LOCAL_MODE, "true");
  for (const [name, value] of Object.entries({
    ZO_TELEMETRY: "false",
    ZO_MMDB_DISABLE_DOWNLOAD: "true",
    ZO_MODEL_PRICING_ENABLED: "false",
    ZO_REGEX_PATTERNS_SOURCE_URL: "",
    ZO_UI_ENABLED: "false",
    ZO_SWAGGER_ENABLED: "false",
    ZO_MCP_ENABLED: "false",
    ZO_PROMETHEUS_ENABLED: "false",
    ZO_QUERY_HISTORY_ENABLED: "false",
  }))
    assert.equal(settings[name], value, name);
  assert.ok(
    container.env.some(
      (variable) =>
        variable.name === "ZO_ROOT_USER_PASSWORD" && variable.valueFrom,
    ),
    "the password comes from a Secret, not a literal",
  );
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(
    (pod.securityContext as { runAsNonRoot: boolean }).runAsNonRoot,
    true,
  );
  assert.equal(pod.automountServiceAccountToken, false);
  assert.ok(container.resources.limits.memory);

  const claim = manifests.find(
    (manifest) =>
      manifest.kind === "PersistentVolumeClaim" &&
      manifest.metadata.name === "openobserve-data",
  );
  assert.ok(claim, "its data is on a persistent volume");
  const service = manifests.find(
    (manifest) =>
      manifest.kind === "Service" && manifest.metadata.name === "openobserve",
  );
  assert.equal(service?.spec?.type, undefined, "a ClusterIP Service");
  for (const ingress of manifests.filter(
    (manifest) => manifest.kind === "Ingress",
  ))
    assert.ok(
      !JSON.stringify(ingress.spec).includes('"openobserve"'),
      ingress.metadata.name,
    );
});

test("Everything reaches OpenObserve with the same retention and reads its password from a file", async () => {
  const manifests = await render();
  const everything = workload(manifests, "everything")!;
  const settings = environment(everything.container);
  assert.equal(
    settings.TELEMETRY_URL,
    "http://openobserve.everything.svc.cluster.local:5080",
  );
  assert.equal(settings.TELEMETRY_RETENTION_DAYS, "7");
  assert.equal(
    settings.TELEMETRY_PASSWORD_FILE,
    "/var/run/secrets/telemetry/password",
  );
  assert.ok(
    !everything.container.env.some(
      (variable) =>
        /PASSWORD$/.test(variable.name) &&
        variable.name.startsWith("TELEMETRY"),
    ),
    "the password is never in the environment fleetd inherits",
  );
  assert.ok(
    everything.container.volumeMounts.some(
      (mount) => mount.mountPath === "/var/run/secrets/telemetry",
    ),
  );
  const secret = manifests.find(
    (manifest) =>
      manifest.kind === "Secret" &&
      manifest.metadata.name === "telemetry-credentials",
  );
  const password = Buffer.from(secret!.data!.password!, "base64").toString(
    "utf8",
  );
  // OpenObserve requires 8–128 characters with lower and upper case letters, a digit, and a symbol.
  assert.match(password, /^Ot1-[0-9a-f]{64}$/);
  assert.match(password, /[a-z]/);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[0-9]/);
  assert.match(password, /[^A-Za-z0-9]/);
  assert.ok(
    !JSON.stringify(manifests).includes(`"${password}"`),
    "the password appears only base64-encoded",
  );
});

test("retention follows one setting, is bounded, and turning OpenObserve off turns telemetry off", async () => {
  const fortnight = await render("telemetry.retentionDays=14");
  assert.equal(
    environment(workload(fortnight, "openobserve")!.container)
      .ZO_COMPACT_DATA_RETENTION_DAYS,
    "14",
  );
  assert.equal(
    environment(workload(fortnight, "everything")!.container)
      .TELEMETRY_RETENTION_DAYS,
    "14",
  );
  for (const days of ["2", "31"])
    await assert.rejects(
      render(`telemetry.retentionDays=${days}`),
      /retentionDays/,
    );
  const off = await render("services.openobserve.enabled=false");
  assert.equal(workload(off, "openobserve"), undefined);
  assert.equal(
    environment(workload(off, "everything")!.container).TELEMETRY_URL,
    "",
  );
});
