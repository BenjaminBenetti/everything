import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import { cookieHost } from "@everything/security/cookie-host";
import { loadApplicationConfig } from "../config/application-config.js";

/** The chart, rendered as cluster:up and the installers render it. */
const chart = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../deployment/helm",
);

/** A rendered object, as far as these checks read it. */
interface Manifest {
  readonly kind: string;
  readonly metadata: { readonly name: string };
  readonly spec?: Record<string, unknown>;
}

/** One container's settings, as the checks read them. */
interface Container {
  readonly env: { name: string; value?: string; valueFrom?: unknown }[];
  readonly ports: { name: string; containerPort: number }[];
}

/** Render the chart with the development values, then `files` and `settings`. */
async function render(
  files: readonly string[] = [],
  settings: readonly string[] = [],
): Promise<Manifest[]> {
  const { stdout } = await promisify(execFile)(
    "helm",
    [
      "template",
      "everything",
      chart,
      "--namespace",
      "everything",
      ...[path.join(chart, "values.dev.yaml"), ...files].flatMap((file) => [
        "--values",
        file,
      ]),
      ...settings.flatMap((setting) => ["--set", setting]),
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return parseAllDocuments(stdout)
    .map((document) => document.toJS() as Manifest | null)
    .filter((manifest): manifest is Manifest => manifest !== null);
}

/** A rendered object of a kind and name. */
function find(manifests: Manifest[], kind: string, name: string): Manifest {
  const found = manifests.find(
    (manifest) => manifest.kind === kind && manifest.metadata.name === name,
  );
  assert.ok(found, `the chart renders ${kind} ${name}`);
  return found;
}

/** A StatefulSet's main container. */
function container(manifests: Manifest[], name: string): Container {
  const template = find(manifests, "StatefulSet", name).spec!.template as {
    spec: { containers: Container[] };
  };
  return template.spec.containers[0]!;
}

/** The environment a container starts with; Secret values are test placeholders. */
function environment(rendered: Container): NodeJS.ProcessEnv {
  return Object.fromEntries(
    rendered.env.map((variable) => [
      variable.name,
      variable.value ?? "test-only",
    ]),
  );
}

test("the chart gives public apps a cookie host of their own, locally and on remote clusters", async () => {
  for (const files of [[], [path.join(chart, "values.prod.yaml")]]) {
    const manifests = await render(files);
    // The artifact service starts with the settings the chart renders for it.
    const config = loadApplicationConfig(
      environment(container(manifests, "artifact")),
    );
    const publicApps = cookieHost(config.publicAppsOrigin);
    assert.notEqual(publicApps, cookieHost(config.artifactOrigin));
    assert.notEqual(publicApps, cookieHost(config.publicOrigin));
    if (files.length === 0) {
      // Locally the forwarded ports are on loopback: the application and the artifact host on
      // localhost, public apps on 127.0.0.1, which browsers keep cookies for apart from localhost's.
      assert.deepEqual(
        [config.publicOrigin, config.artifactOrigin, config.publicAppsOrigin],
        [
          "http://localhost:8080",
          "http://localhost:8081",
          "http://127.0.0.1:8082",
        ],
      );
    } else {
      assert.equal(config.publicAppsOrigin, "https://public-apps.example.com");
    }
  }
});

test("the artifact service refuses a public apps hostname shared with the artifact host or the application", async () => {
  for (const hostname of ["localhost", "LOCALHOST.", "Localhost"]) {
    const manifests = await render(
      [],
      [`global.externalPublicAppsHostname=${hostname}`],
    );
    assert.throws(
      () =>
        loadApplicationConfig(environment(container(manifests, "artifact"))),
      /PUBLIC_APPS_ORIGIN needs a hostname apart/,
      hostname,
    );
  }
});

test("teammate pods reach the public apps host on a Service whose hostname is not the artifact host's", async () => {
  for (const files of [[], [path.join(chart, "values.prod.yaml")]]) {
    const manifests = await render(files);
    const everything = environment(container(manifests, "everything"));
    assert.equal(
      everything.ARTIFACT_HOST_URL,
      "http://artifact.everything.svc.cluster.local:8080",
    );
    assert.equal(
      everything.ARTIFACT_PUBLIC_APPS_HOST_URL,
      "http://public-apps.everything.svc.cluster.local:8082",
    );
    // The public-apps Service selects the artifact service's pods on the public apps host's port,
    // which the artifact Service no longer exposes.
    const artifact = container(manifests, "artifact");
    assert.ok(
      artifact.ports.some(
        (port) => port.name === "public" && port.containerPort === 8082,
      ),
    );
    const service = find(manifests, "Service", "public-apps").spec!;
    assert.deepEqual(service.selector, { app: "artifact" });
    assert.deepEqual(service.ports, [
      { name: "public", port: 8082, targetPort: "public" },
    ]);
    assert.deepEqual(
      (
        find(manifests, "Service", "artifact").spec!.ports as { name: string }[]
      ).map((port) => port.name),
      ["http", "internal"],
    );
    // The public apps Ingress routes to the same Service, and the artifact host's to its own.
    const backends = (name: string) =>
      (
        find(manifests, "Ingress", name).spec!.rules as {
          http: { paths: { backend: { service: unknown } }[] };
        }[]
      ).flatMap((rule) =>
        rule.http.paths.map((entry) => entry.backend.service),
      );
    assert.deepEqual(backends("everything-public-apps"), [
      { name: "public-apps", port: { name: "public" } },
    ]);
    assert.deepEqual(backends("everything-artifacts"), [
      { name: "artifact", port: { name: "http" } },
    ]);
  }
});
