import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import {
  CommandFailure,
  type CommandRunner,
} from "../interface/command-runner.js";
import { HelmUpgrade, UpgradeFailure } from "../service/helm-upgrade.js";

/** The chart this repository releases next: the version an installed upgrader upgrades to. */
const chart = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../deployment/helm",
);

const release = {
  chart: "oci://ghcr.io/benjaminbenetti/everything/charts/everything",
  plainHttp: false,
  name: "everything",
  namespace: "everything",
};

/**
 * Settings as the installer of v0.8.0, the last release before public apps, saved them: hostnames,
 * each Ingress's class and TLS, the storage class, every credential, and a disk size, in its layout of
 * nested keys and quoted values. Nothing for public apps, which that version did not have.
 */
function legacySettings(tls: "issuer" | "controller"): string {
  const site = (name: string, secret: string, extra: string[] = []) => [
    `  ${name}:`,
    `    className: '${tls === "issuer" ? "nginx" : ""}'`,
    ...(tls === "issuer" || extra.length
      ? [
          "    annotations:",
          ...extra,
          ...(tls === "issuer"
            ? ["      cert-manager.io/cluster-issuer: 'letsencrypt'"]
            : []),
        ]
      : []),
    `    tlsSecretName: '${tls === "issuer" ? secret : ""}'`,
  ];
  return [
    "# Everything's installation settings and credentials, written by install.sh. Keep this file",
    "# private. Later runs of the installer reuse it and ask only for what it lacks; they rewrite it,",
    "# so keep its plain layout of nested keys and quoted values. Changing a database password here",
    "# after the first installation does not change it inside PostgreSQL.",
    "# namespace: everything",
    "global:",
    "  externalHostname: 'everything.example.org'",
    "  externalArtifactHostname: 'artifacts.example.org'",
    "  externalRegistryHostname: 'images.example.org'",
    ...site("ingress", "everything-tls"),
    ...site("artifactIngress", "everything-artifacts-tls"),
    ...site(
      "registryIngress",
      "everything-registry-tls",
      tls === "issuer"
        ? ["      nginx.ingress.kubernetes.io/proxy-body-size: '0'"]
        : [],
    ),
    "  storageClassName: ''",
    "secrets:",
    "  database-credentials:",
    "    admin: 'saved-admin'",
    "    keycloak: 'saved-keycloak'",
    "    everything: 'saved-everything'",
    "    artifact: 'saved-artifact'",
    "  keycloak-credentials:",
    "    admin: 'saved-keycloak-admin'",
    "  browser-auth:",
    "    client-secret: 'saved-browser'",
    `    session-encryption-key: '${"A".repeat(43)}='`,
    "  artifact-auth:",
    "    client-secret: 'saved-artifact-client'",
    "  app-provisioner-auth:",
    "    client-secret: 'saved-provisioner'",
    "  registry-credentials:",
    "    username: 'everything'",
    "    password: 'saved-registry'",
    "services:",
    "  postgres:",
    "    volumes:",
    "      data:",
    "        persistentVolume:",
    "          size: '30Gi'",
    "",
  ].join("\n");
}

/** Add lines under `global:` to settings, as the installer of a version with public apps writes them. */
function withGlobals(settings: string, lines: string[]): string {
  return settings.replace(
    "  storageClassName: ''\n",
    ["  storageClassName: ''", ...lines, ""].join("\n"),
  );
}

/** A rendered object, as far as these checks read it. */
interface Manifest {
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly annotations?: Record<string, string>;
  };
  readonly spec?: Record<string, unknown>;
  readonly data?: Record<string, string>;
}

/** An Ingress's spec, as the checks read it. */
interface IngressSpec {
  readonly ingressClassName?: string;
  readonly tls?: { hosts: string[]; secretName: string }[];
  readonly rules: {
    host?: string;
    http: { paths: { backend: { service: unknown } }[] };
  }[];
}

/**
 * Helm as an installed upgrader's Job runs it, with no cluster. `pull` unpacks the chart this
 * repository publishes next, packaged as the release workflow packages it. `upgrade` must receive
 * exactly v0.8.0's arguments, and renders the release from them: `helm upgrade` renders every
 * template, with the values and files it was given, before it changes anything in the cluster. Only
 * the flags about the cluster are left out; `--reset-values` is what `helm template` always does.
 */
async function offlineHelm(context: TestContext, work: string) {
  const execute = promisify(execFile);
  await execute("helm", [
    "package",
    chart,
    "--destination",
    work,
    "--version",
    "9.9.9",
    "--app-version",
    "9.9.9",
  ]);
  const rendered: Manifest[] = [];
  const upgrades: string[][] = [];
  context.after(() => rm(work, { recursive: true, force: true }));
  const runner: CommandRunner = {
    async run(program, args) {
      assert.equal(program, "helm");
      if (args[0] === "pull") {
        await execute("tar", [
          "-xzf",
          path.join(work, "everything-9.9.9.tgz"),
          "-C",
          args[args.indexOf("--untardir") + 1]!,
        ]);
        return;
      }
      upgrades.push([...args]);
      const directory = args[2]!;
      const settingsFile = args[9]!;
      assert.deepEqual(args, [
        "upgrade",
        release.name,
        directory,
        "--namespace",
        release.namespace,
        "--reset-values",
        "--values",
        path.join(directory, "values.prod.yaml"),
        "--values",
        settingsFile,
        "--set-file",
        `upgrades.settings=${settingsFile}`,
        "--rollback-on-failure",
        "--wait",
        "--timeout",
        "15m",
      ]);
      try {
        const { stdout } = await execute(
          "helm",
          ["template", ...args.slice(1, 5), ...args.slice(6, 12)],
          { maxBuffer: 32 * 1024 * 1024 },
        );
        rendered.push(
          ...parseAllDocuments(stdout)
            .map((document) => document.toJS() as Manifest | null)
            .filter((manifest): manifest is Manifest => manifest !== null),
        );
      } catch (error) {
        throw new CommandFailure("helm", (error as { stderr: string }).stderr);
      }
    },
  };
  return { runner, rendered, upgrades };
}

/** Write a settings file where the upgrader keeps it, and remember its bytes and modification time. */
async function saved(work: string, settings: string) {
  const file = path.join(work, "settings.yaml");
  await writeFile(file, settings, { mode: 0o600 });
  const before = (await stat(file)).mtimeMs;
  return {
    file,
    /** Check the upgrade left the file exactly as it was. */
    async unchanged(): Promise<void> {
      assert.equal(await readFile(file, "utf8"), settings);
      assert.equal((await stat(file)).mtimeMs, before);
    },
  };
}

/** A rendered object of a kind and name. */
function find(manifests: Manifest[], kind: string, name: string): Manifest {
  const found = manifests.find(
    (manifest) => manifest.kind === kind && manifest.metadata.name === name,
  );
  assert.ok(found, `the chart renders ${kind} ${name}`);
  return found;
}

/** A workload's main container's environment, as literal values. */
function environment(
  manifests: Manifest[],
  name: string,
): Record<string, string | undefined> {
  const template = find(manifests, "StatefulSet", name).spec!.template as {
    spec: { containers: { env: { name: string; value?: string }[] }[] };
  };
  return Object.fromEntries(
    template.spec.containers[0]!.env.map((variable) => [
      variable.name,
      variable.value,
    ]),
  );
}

for (const tls of ["issuer", "controller"] as const)
  test(`an installed upgrader taking settings saved before public apps to this chart stops at the render, changing nothing (TLS from ${tls === "issuer" ? "an issuer" : "the controller"})`, async (context) => {
    const work = await mkdtemp(path.join(tmpdir(), "legacy-upgrade-"));
    const helm = await offlineHelm(context, work);
    const settings = await saved(work, legacySettings(tls));
    await assert.rejects(
      new HelmUpgrade(
        { ...release, settingsFile: settings.file },
        helm.runner,
        work,
      ).install("9.9.9"),
      (error: unknown) => {
        assert.ok(error instanceof UpgradeFailure);
        // The person who started the upgrade reads this one line in Settings.
        assert.doesNotMatch(error.message, /\n/);
        assert.match(
          error.message,
          /^Error: .*Public apps need a hostname of their own, global\.externalPublicAppsHostname, with DNS pointing at your ingress\. Nothing was changed\. Run this version's installer, which asks for it, keeps your other settings, and finishes the upgrade\.$/,
        );
        return true;
      },
    );
    // The upgrade ran once, with v0.8.0's arguments, and rendered nothing Helm could apply.
    assert.equal(helm.upgrades.length, 1);
    assert.deepEqual(helm.rendered, []);
    await settings.unchanged();
  });

test("settings with a public apps hostname upgrade to the public apps host and keep everything else", async (context) => {
  const work = await mkdtemp(path.join(tmpdir(), "legacy-upgrade-"));
  const helm = await offlineHelm(context, work);
  // What this version's installer adds to the settings above: the hostname, and the public apps
  // Ingress's class and TLS, taken from the artifact host's.
  const configured = withGlobals(legacySettings("issuer"), [
    "  externalPublicAppsHostname: 'public-apps.example.org'",
    "  publicAppsIngress:",
    "    className: 'nginx'",
    "    annotations:",
    "      cert-manager.io/cluster-issuer: 'letsencrypt'",
    "    tlsSecretName: 'everything-public-apps-tls'",
  ]);
  const settings = await saved(work, configured);
  await new HelmUpgrade(
    { ...release, settingsFile: settings.file },
    helm.runner,
    work,
  ).install("9.9.9");
  const manifests = helm.rendered;
  const ingress = (name: string) =>
    find(manifests, "Ingress", name) as Manifest & { spec: IngressSpec };
  const publicApps = ingress("everything-public-apps");
  assert.equal(publicApps.spec.ingressClassName, "nginx");
  assert.deepEqual(publicApps.metadata.annotations, {
    "cert-manager.io/cluster-issuer": "letsencrypt",
  });
  assert.deepEqual(publicApps.spec.tls, [
    {
      hosts: ["public-apps.example.org"],
      secretName: "everything-public-apps-tls",
    },
  ]);
  assert.equal(publicApps.spec.rules[0]!.host, "public-apps.example.org");
  assert.deepEqual(publicApps.spec.rules[0]!.http.paths[0]!.backend.service, {
    name: "public-apps",
    port: { name: "public" },
  });
  find(manifests, "Service", "public-apps");
  // The application's and the artifact host's routing is as the saved settings had it.
  for (const [name, host, secret] of [
    ["everything", "everything.example.org", "everything-tls"],
    [
      "everything-artifacts",
      "artifacts.example.org",
      "everything-artifacts-tls",
    ],
  ] as const) {
    assert.equal(ingress(name).spec.rules[0]!.host, host);
    assert.deepEqual(ingress(name).spec.tls, [
      { hosts: [host], secretName: secret },
    ]);
  }
  const artifact = environment(manifests, "artifact");
  assert.equal(artifact.PUBLIC_ORIGIN, "https://everything.example.org");
  assert.equal(artifact.ARTIFACT_ORIGIN, "https://artifacts.example.org");
  assert.equal(artifact.PUBLIC_APPS_ORIGIN, "https://public-apps.example.org");
  assert.equal(
    artifact.ARTIFACT_INTERNAL_HOSTNAMES,
    "artifact.everything.svc.cluster.local",
  );
  assert.equal(
    artifact.PUBLIC_APPS_INTERNAL_HOSTNAMES,
    "public-apps.everything.svc.cluster.local",
  );
  const everything = environment(manifests, "everything");
  assert.equal(
    everything.ARTIFACT_HOST_URL,
    "http://artifact.everything.svc.cluster.local:8080",
  );
  assert.equal(
    everything.ARTIFACT_PUBLIC_APPS_HOST_URL,
    "http://public-apps.everything.svc.cluster.local:8082",
  );
  // The settings stay in the cluster, unchanged, for the next upgrade.
  assert.equal(
    Buffer.from(
      find(manifests, "Secret", "upgrade-settings").data!["values.yaml"]!,
      "base64",
    ).toString("utf8"),
    configured,
  );
  await settings.unchanged();
});

test("a public apps host on plain HTTP, with no class or TLS, upgrades as configured", async (context) => {
  const work = await mkdtemp(path.join(tmpdir(), "legacy-upgrade-"));
  const helm = await offlineHelm(context, work);
  const settings = await saved(
    work,
    withGlobals(legacySettings("controller"), [
      "  externalPublicAppsHostname: 'apps.example.net'",
      "  publicAppsOrigin: 'http://apps.example.net'",
      "  publicAppsIngress:",
      "    className: ''",
      "    tlsSecretName: ''",
    ]),
  );
  await new HelmUpgrade(
    { ...release, settingsFile: settings.file },
    helm.runner,
    work,
  ).install("9.9.9");
  const publicApps = find(helm.rendered, "Ingress", "everything-public-apps")
    .spec as unknown as IngressSpec;
  assert.equal(publicApps.ingressClassName, undefined);
  assert.equal(publicApps.tls, undefined);
  assert.equal(publicApps.rules[0]!.host, "apps.example.net");
  assert.equal(
    environment(helm.rendered, "artifact").PUBLIC_APPS_ORIGIN,
    "http://apps.example.net",
  );
  await settings.unchanged();
});
