import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import { cookieHost } from "@everything/security/cookie-host";
import type { ArtifactHostDependencies } from "../../viewing/controller/artifact-host-controller.js";
import type { PublicAppsHostDependencies } from "../../viewing/controller/public-apps-host-controller.js";
import { ViewCookie } from "../../viewing/handler/view-cookie.js";
import { ViewPassCredentials } from "../../viewing/handler/view-pass-credentials.js";
import { loadApplicationConfig } from "../config/application-config.js";
import {
  createPublicApplication,
  createPublicAppsApplication,
} from "../factory/public-application.js";

/** The chart, rendered as cluster:up and the installers render it. */
const chart = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../deployment/helm",
);

/**
 * The values each check renders: the development stack's, and a remote cluster's production values
 * with the settings its installation adds, which values.prod.yaml needs for public apps.
 */
const layouts = [
  [],
  [
    path.join(chart, "values.prod.yaml"),
    path.join(chart, "ci/remote-cluster-settings.yaml"),
  ],
] as const;

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
  readonly startupProbe?: Probe;
  readonly readinessProbe?: Probe;
  readonly livenessProbe?: Probe;
}

/** A container probe, as the checks read it. */
interface Probe {
  readonly httpGet: { readonly path: string; readonly port: string };
}

/** An Ingress rule, as the checks read it. */
interface Rule {
  readonly host?: string;
  readonly http: { paths: { backend: { service: unknown } }[] };
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
  for (const files of layouts) {
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
      /PUBLIC_APPS_ORIGIN and PUBLIC_APPS_INTERNAL_HOSTNAMES need hostnames apart/,
      hostname,
    );
  }
});

test("teammate pods reach the public apps host on a Service whose hostname is not the artifact host's", async () => {
  for (const files of layouts) {
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
      (find(manifests, "Ingress", name).spec!.rules as Rule[]).flatMap((rule) =>
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

test("each viewer host the chart composes serves its own origin and in-cluster hostname, and refuses the other's", async () => {
  for (const files of layouts) {
    const manifests = await render(files);
    const config = loadApplicationConfig(
      environment(container(manifests, "artifact")),
    );
    const everything = environment(container(manifests, "everything"));
    // view_app's in-cluster URLs are the internal hostnames each host serves.
    assert.ok(
      config.viewerHostnames.artifact.includes(
        cookieHost(everything.ARTIFACT_HOST_URL!),
      ),
    );
    assert.ok(
      config.viewerHostnames.publicApps.includes(
        cookieHost(everything.ARTIFACT_PUBLIC_APPS_HOST_URL!),
      ),
    );
    // The production factories, given the configuration the chart renders, admit exactly those.
    const host = await createPublicApplication(
      {
        access: { viewer: async () => undefined },
        cookie: new ViewCookie(config.artifactOrigin),
        passes: { find: async () => undefined },
        passCredentials: new ViewPassCredentials(),
        apiKeys: { authenticate: async () => undefined },
        artifacts: { findBySlug: async () => undefined },
        publicOrigin: config.publicOrigin,
      } as unknown as ArtifactHostDependencies,
      config.viewerHostnames.artifact,
    );
    const publicApps = await createPublicAppsApplication(
      {
        artifacts: { findBySlug: async () => undefined },
        publicOrigin: config.publicOrigin,
      } as unknown as PublicAppsHostDependencies,
      config.viewerHostnames.publicApps,
    );
    try {
      /** The status a host answers a request for an unknown app with, under a URL's host. */
      const status = async (app: typeof host, url: string) =>
        (
          await app.inject({
            url: "/unknown/",
            headers: { host: new URL(url).host },
          })
        ).statusCode;
      const port = (url: string, other: string) =>
        `http://${cookieHost(url)}:${new URL(other).port || 80}`;
      for (const url of [config.artifactOrigin, everything.ARTIFACT_HOST_URL!])
        assert.equal(await status(host, url), 401, url);
      for (const url of [
        config.publicAppsOrigin,
        everything.ARTIFACT_PUBLIC_APPS_HOST_URL!,
        // The public apps host's hostname on the artifact host's port, as a hostless Ingress routes it.
        port(config.publicAppsOrigin, config.artifactOrigin),
      ])
        assert.equal(await status(host, url), 421, url);
      for (const url of [
        config.publicAppsOrigin,
        everything.ARTIFACT_PUBLIC_APPS_HOST_URL!,
      ])
        assert.equal(await status(publicApps, url), 404, url);
      for (const url of [
        config.artifactOrigin,
        config.publicOrigin,
        everything.ARTIFACT_HOST_URL!,
        port(config.artifactOrigin, config.publicAppsOrigin),
      ])
        assert.equal(await status(publicApps, url), 421, url);
    } finally {
      await host.close();
      await publicApps.close();
    }
    // Health is served on the internal port, which no Ingress routes, so it needs no hostname.
    const artifact = container(manifests, "artifact");
    for (const probe of [
      artifact.startupProbe,
      artifact.readinessProbe,
      artifact.livenessProbe,
    ])
      assert.equal(probe?.httpGet.port, "internal");
    // Kubernetes refuses an IP address as an Ingress host, so locally the public apps Ingress has
    // none and the public apps host's own check is what refuses localhost; elsewhere each Ingress
    // routes only its own hostname as well.
    const hostsOf = (name: string) =>
      (find(manifests, "Ingress", name).spec!.rules as Rule[]).map(
        (rule) => rule.host,
      );
    if (files.length === 0) {
      assert.deepEqual(hostsOf("everything-public-apps"), [undefined]);
    } else {
      assert.deepEqual(hostsOf("everything-public-apps"), [
        cookieHost(config.publicAppsOrigin),
      ]);
      assert.deepEqual(hostsOf("everything-artifacts"), [
        cookieHost(config.artifactOrigin),
      ]);
    }
  }
});
