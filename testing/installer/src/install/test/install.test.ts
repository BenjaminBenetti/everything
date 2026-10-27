import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { parse } from "yaml";
import {
  FakeHost,
  executable,
  scriptDirectory,
} from "../../local/fixture/fake-host.js";

/** The chart version with public apps, and one released before them. */
const current = "9.9.9";
const legacy = "0.8.0";

/**
 * The real Helm: the fake one hands it every render, so a chart's schema checks the values the
 * installer gives it, as a published chart's does.
 */
const realHelm = (() => {
  const found = spawnSync("bash", ["-c", "command -v helm"], {
    encoding: "utf8",
  });
  if (found.status !== 0)
    throw new Error(
      "The installer tests render their fixture charts with Helm; install Helm 3.8 or newer.",
    );
  return found.stdout.trim();
})();

let host: FakeHost;
let settings: string;

/** The settings of one Ingress, as the published charts declare them. */
const ingressSettings = {
  type: "object",
  additionalProperties: false,
  properties: {
    className: { type: "string" },
    host: { type: "string" },
    annotations: { type: "object", additionalProperties: { type: "string" } },
    tlsSecretName: { type: "string" },
  },
};

/**
 * A chart as `helm pull` downloads it, with one credential and one disk. Like the published charts,
 * its schema refuses any global setting it does not declare; only a chart with public apps declares
 * theirs.
 */
function writeChart(version: string, publicApps: boolean): void {
  const source = join(host.directory, `chart-source-${version}/everything`);
  mkdirSync(join(source, "templates"), { recursive: true });
  const ingress =
    '{ className: "", host: "", annotations: {}, tlsSecretName: "" }';
  writeFileSync(
    join(source, "Chart.yaml"),
    `apiVersion: v2\nname: everything\nversion: ${version}\n`,
  );
  writeFileSync(
    join(source, "values.yaml"),
    [
      "global:",
      "  externalHostname: localhost",
      "  externalArtifactHostname: localhost",
      ...(publicApps
        ? [
            "  externalPublicAppsHostname: 127.0.0.1",
            '  publicAppsOrigin: "http://127.0.0.1:8082"',
          ]
        : []),
      "  externalRegistryHostname: registry.everything.test",
      `  ingress: ${ingress}`,
      `  artifactIngress: ${ingress}`,
      ...(publicApps ? [`  publicAppsIngress: ${ingress}`] : []),
      `  registryIngress: ${ingress}`,
      '  storageClassName: ""',
      "secrets:",
      "  database-credentials:",
      '    admin: ""',
      "services:",
      "  postgres:",
      "    volumes:",
      "      data:",
      "        persistentVolume: { size: 20Gi }",
      "upgrades:",
      '  settings: ""',
      "",
    ].join("\n"),
  );
  const globals: Record<string, unknown> = {
    externalHostname: { type: "string" },
    externalArtifactHostname: { type: "string" },
    externalRegistryHostname: { type: "string" },
    ingress: ingressSettings,
    artifactIngress: ingressSettings,
    registryIngress: ingressSettings,
    storageClassName: { type: "string" },
    ...(publicApps
      ? {
          externalPublicAppsHostname: { type: "string" },
          publicAppsOrigin: { type: "string" },
          publicAppsIngress: ingressSettings,
        }
      : {}),
  };
  writeFileSync(
    join(source, "values.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        global: {
          type: "object",
          additionalProperties: false,
          properties: globals,
        },
      },
    }),
  );
  writeFileSync(
    join(source, "values.prod.yaml"),
    [
      "global:",
      "  externalHostname: everything.example.com",
      "  externalArtifactHostname: artifacts.example.com",
      ...(publicApps
        ? [
            "  externalPublicAppsHostname: public-apps.example.com",
            '  publicAppsOrigin: "https://{{ .Values.global.externalPublicAppsHostname }}"',
          ]
        : []),
      "  externalRegistryHostname: images.example.com",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(source, "templates/persistent-volume-claims.yaml"),
    [
      "apiVersion: v1",
      "kind: PersistentVolumeClaim",
      "metadata:",
      "  name: postgres-data",
      "  labels:",
      "    app.kubernetes.io/name: postgres",
      "spec:",
      "  resources:",
      "    requests:",
      "      storage: {{ .Values.services.postgres.volumes.data.persistentVolume.size | quote }}",
      "",
    ].join("\n"),
  );
  mkdirSync(join(host.directory, "charts"), { recursive: true });
  execFileSync("tar", [
    "-czf",
    join(host.directory, "charts", `everything-${version}.tgz`),
    "-C",
    join(host.directory, `chart-source-${version}`),
    "everything",
  ]);
}

beforeEach(() => {
  host = new FakeHost();
  writeChart(current, true);
  writeChart(legacy, false);
  settings = join(host.directory, "settings.yaml");
  // Helm downloads the chosen chart, and the real Helm renders it, checking the values against the
  // chart's schema, both for the disks and for the release it would install. Keycloak never becomes
  // ready, so the installer skips the first user.
  executable(
    join(host.bin, "helm"),
    `#!/bin/bash
printf 'helm %s\\n' "$*" >> "$FAKE_LOG"
export HELM_CACHE_HOME="$FAKE_HELM_HOME/cache" HELM_CONFIG_HOME="$FAKE_HELM_HOME/config" HELM_DATA_HOME="$FAKE_HELM_HOME/data"
# Keep every values file each command receives, for the tests to read.
record() {
  local command=$1 previous="" argument
  shift
  for argument in "$@"; do
    case $previous in
      --values) { printf -- '--- %s\\n' "$argument"; cat "$argument"; } >> "$FAKE_LOG.$command-values" ;;
      --set-file) cp "\${argument#upgrades.settings=}" "$FAKE_LOG.upgrade-settings" ;;
    esac
    previous=$argument
  done
}
case $1 in
  show) echo "version: ${current}" ;;
  pull)
    version="" destination=""
    while [ $# -gt 0 ]; do
      case $1 in
        --version) version=$2; shift ;;
        --destination) destination=$2; shift ;;
      esac
      shift
    done
    cp "$FAKE_CHARTS/everything-$version.tgz" "$destination/" || exit 1
    ;;
  template)
    record template "$@"
    exec "$REAL_HELM" "$@"
    ;;
  status) exit 1 ;;
  upgrade)
    record upgrade "$@"
    # No cluster: the real Helm renders the release instead, checking its values as an upgrade does.
    shift
    arguments=(template)
    while [ $# -gt 0 ]; do
      case $1 in
        --install) ;;
        --kube-context) shift ;;
        *) arguments+=("$1") ;;
      esac
      shift
    done
    "$REAL_HELM" "\${arguments[@]}" > /dev/null
    ;;
esac
`,
  );
  executable(
    join(host.bin, "kubectl"),
    `#!/bin/bash
printf 'kubectl %s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  "config current-context") echo test-context ;;
  *"rollout status"*) exit 1 ;;
  *apply*) cat > /dev/null ;;
esac
`,
  );
});

afterEach(() => {
  host.dispose();
});

function runInstaller(answers: string[], env: Record<string, string> = {}) {
  return host.run({
    script: join(scriptDirectory, "install.sh"),
    answers,
    env: {
      EVERYTHING_VERSION: current,
      REAL_HELM: realHelm,
      FAKE_CHARTS: join(host.directory, "charts"),
      FAKE_HELM_HOME: join(host.directory, "helm-home"),
      ...env,
    },
  });
}

/** The global settings in a values file. */
function globals(values: string): Record<string, unknown> {
  return (
    (parse(values) as { global?: Record<string, unknown> } | null)?.global ?? {}
  );
}

/** The installation's own values files given to a Helm command, without the chart's production values. */
function givenSettings(command: "template" | "upgrade"): string[] {
  return host
    .read(`${host.log}.${command}-values`)
    .split(/^--- /m)
    .filter(
      (section) =>
        section && !section.split("\n", 1)[0]!.endsWith("/values.prod.yaml"),
    )
    .map((section) => section.slice(section.indexOf("\n") + 1));
}

/** The settings for public apps a values file holds. */
function publicAppsSettings(values: string): string[] {
  return Object.keys(globals(values)).filter((key) =>
    [
      "externalPublicAppsHostname",
      "publicAppsOrigin",
      "publicAppsIngress",
    ].includes(key),
  );
}

/** Settings that a chart from before public apps refuses, and every chart accepts otherwise. */
const legacySettings = [
  "# namespace: everything",
  "global:",
  "  externalHostname: 'everything.example.com'",
  "  externalArtifactHostname: 'artifacts.example.com'",
  "  externalRegistryHostname: 'images.example.com'",
  "  ingress:",
  "    className: 'nginx'",
  "    annotations:",
  "      cert-manager.io/cluster-issuer: 'letsencrypt'",
  "    tlsSecretName: 'everything-tls'",
  "  artifactIngress:",
  "    className: 'nginx'",
  "    annotations:",
  "      cert-manager.io/cluster-issuer: 'letsencrypt'",
  "    tlsSecretName: 'everything-artifacts-tls'",
  "  registryIngress:",
  "    className: 'nginx'",
  "    annotations:",
  "      nginx.ingress.kubernetes.io/proxy-body-size: '0'",
  "      cert-manager.io/cluster-issuer: 'letsencrypt'",
  "    tlsSecretName: 'everything-registry-tls'",
  "  storageClassName: ''",
  "secrets:",
  "  database-credentials:",
  "    admin: 'saved-db-password'",
  "services:",
  "  postgres:",
  "    volumes:",
  "      data:",
  "        persistentVolume:",
  "          size: '30Gi'",
  "",
].join("\n");

/** A preset like install-k3s.sh's, with settings for public apps beside the others. */
function writeLocalPreset(): string {
  const preset = join(host.directory, "preset.yaml");
  const site = (name: string) => [
    `  ${name}:`,
    "    className: 'traefik'",
    "    annotations:",
    "      traefik.ingress.kubernetes.io/router.entrypoints: 'websecure'",
    "    tlsSecretName: 'everything-local-tls'",
  ];
  writeFileSync(
    preset,
    [
      "# namespace: local",
      "global:",
      "  externalHostname: 'everything.internal'",
      "  externalArtifactHostname: 'artifacts.everything.internal'",
      "  externalPublicAppsHostname: 'public-apps.everything.internal'",
      "  externalRegistryHostname: 'images.everything.internal'",
      ...site("ingress"),
      ...site("artifactIngress"),
      ...site("publicAppsIngress"),
      ...site("registryIngress"),
      "  storageClassName: 'local-path'",
      "services:",
      "  voice-asr:",
      "    enabled: false",
      "",
    ].join("\n"),
  );
  return preset;
}

describe("the fixture charts", () => {
  test("refuse undeclared global settings, as the published charts do", () => {
    const values = join(host.directory, "values.yaml");
    const render = (version: string, global: string) => {
      writeFileSync(values, `global:\n${global}`);
      return spawnSync(
        realHelm,
        [
          "template",
          "everything",
          join(host.directory, "charts", `everything-${version}.tgz`),
          "--values",
          values,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HELM_CACHE_HOME: join(host.directory, "helm-home/cache"),
            HELM_CONFIG_HOME: join(host.directory, "helm-home/config"),
            HELM_DATA_HOME: join(host.directory, "helm-home/data"),
          },
        },
      );
    };
    const hostname =
      "  externalPublicAppsHostname: 'public-apps.example.com'\n";
    const ingress = "  publicAppsIngress:\n    className: 'nginx'\n";
    const shared = "  externalHostname: 'everything.example.com'\n";
    assert.equal(render(legacy, shared).status, 0);
    for (const global of [
      hostname,
      ingress,
      "  publicAppsOrigin: 'https://a.b'\n",
    ]) {
      const refused = render(legacy, shared + global);
      assert.notEqual(refused.status, 0, global);
      assert.match(refused.stderr, /additional propert/i, global);
    }
    assert.equal(render(current, shared + hostname + ingress).status, 0);
    assert.notEqual(
      render(current, `${shared}  unknownSetting: 'x'\n`).status,
      0,
    );
  });
});

describe("install.sh", () => {
  test("asks for every cluster setting without a preset, as before", async () => {
    const result = await runInstaller([
      settings,
      "",
      "everything",
      "everything.example.com",
      "",
      "",
      "",
      "nginx",
      "letsencrypt",
      "",
      "db-password",
      "",
      "y",
    ]);
    assert.equal(result.status, 0, result.output);
    for (const question of [
      "Namespace to install into",
      "Hostname the application is served on",
      "Hostname for apps",
      "Hostname for public apps",
      "Hostname of the image registry",
      "ingress class",
      "ClusterIssuer",
      "storage class",
    ]) {
      assert.ok(result.output.includes(question), question);
    }
    assert.match(
      result.output,
      /Point DNS for everything\.example\.com, artifacts\.example\.com, public-apps\.example\.com,\n {2}and images\.example\.com/,
    );
    const saved = readFileSync(settings, "utf8");
    assert.equal(statSync(settings).mode & 0o777, 0o600);
    assert.match(saved, /^# namespace: everything$/m);
    assert.match(saved, /^  externalHostname: 'everything\.example\.com'$/m);
    assert.match(
      saved,
      /^  externalArtifactHostname: 'artifacts\.example\.com'$/m,
    );
    assert.match(
      saved,
      /^  externalPublicAppsHostname: 'public-apps\.example\.com'$/m,
    );
    assert.match(
      saved,
      /^      nginx\.ingress\.kubernetes\.io\/proxy-body-size: '0'$/m,
    );
    assert.match(
      saved,
      /^      cert-manager\.io\/cluster-issuer: 'letsencrypt'$/m,
    );
    assert.deepEqual(globals(saved).publicAppsIngress, {
      className: "nginx",
      annotations: { "cert-manager.io/cluster-issuer": "letsencrypt" },
      tlsSecretName: "everything-public-apps-tls",
    });
    assert.match(saved, /^    admin: 'db-password'$/m);
    assert.match(
      host.read(host.log),
      /helm upgrade everything .* --kube-context test-context --namespace everything/,
    );
    // The chart's schema took the settings, for the disks and for the release.
    assert.equal(host.read(`${host.log}.upgrade-settings`), saved);
    for (const command of ["template", "upgrade"] as const)
      assert.deepEqual(publicAppsSettings(givenSettings(command).at(-1)!), [
        "externalPublicAppsHostname",
        "publicAppsIngress",
      ]);
  });

  test("installs a chart from before public apps without asking for, writing, or mentioning them", async () => {
    const result = await runInstaller(
      [
        settings,
        "",
        "everything",
        "everything.example.com",
        "",
        "",
        "nginx",
        "letsencrypt",
        "",
        "db-password",
        "",
        "y",
      ],
      { EVERYTHING_VERSION: legacy },
    );
    assert.equal(result.status, 0, result.output);
    assert.ok(!result.output.includes("Hostname for public apps"));
    for (const question of [
      "Hostname for apps",
      "Hostname of the image registry",
      "ingress class",
      "ClusterIssuer",
      "storage class",
    ])
      assert.ok(result.output.includes(question), question);
    assert.match(
      result.output,
      /Point DNS for everything\.example\.com, artifacts\.example\.com,\n {2}and images\.example\.com at your ingress controller/,
    );
    assert.doesNotMatch(result.output, /public/i);
    const saved = readFileSync(settings, "utf8");
    assert.deepEqual(publicAppsSettings(saved), []);
    assert.equal(
      globals(saved).externalArtifactHostname,
      "artifacts.example.com",
    );
    assert.deepEqual(
      (globals(saved).artifactIngress as Record<string, unknown>).annotations,
      { "cert-manager.io/cluster-issuer": "letsencrypt" },
    );
    assert.equal(host.read(`${host.log}.upgrade-settings`), saved);
    for (const command of ["template", "upgrade"] as const)
      for (const values of givenSettings(command))
        assert.deepEqual(publicAppsSettings(values), [], command);
    assert.match(host.read(host.log), /helm upgrade everything/);
  });

  test("takes a preset's settings and namespace, and leaves DNS to its caller", async () => {
    const preset = writeLocalPreset();
    const defaultSettings = join(
      host.directory,
      "state/everything-values.yaml",
    );
    mkdirSync(join(host.directory, "state"));
    const result = await runInstaller(["", "", "", "", "y"], {
      EVERYTHING_PRESET_SETTINGS: preset,
      EVERYTHING_SETTINGS_FILE: defaultSettings,
    });
    assert.equal(result.status, 0, result.output);
    for (const question of [
      "Namespace to install into",
      "Hostname",
      "Name of the ingress class",
      "Name of the cert-manager ClusterIssuer",
      "Name of the storage class",
    ]) {
      assert.ok(!result.output.includes(question), question);
    }
    assert.match(
      result.output,
      new RegExp(
        `Settings file, kept for later upgrades \\[${defaultSettings}\\]`,
      ),
    );
    assert.doesNotMatch(result.output, /Point DNS/);
    assert.match(result.output, /Sign in at https:\/\/everything\.internal/);
    const saved = readFileSync(defaultSettings, "utf8");
    assert.match(saved, /^# namespace: local$/m);
    assert.match(saved, /^  externalHostname: 'everything\.internal'$/m);
    assert.match(saved, /^    tlsSecretName: 'everything-local-tls'$/m);
    assert.match(saved, /^    enabled: false$/m);
    assert.equal(
      globals(saved).externalPublicAppsHostname,
      "public-apps.everything.internal",
    );
    assert.deepEqual(globals(saved).publicAppsIngress, {
      className: "traefik",
      annotations: {
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
      tlsSecretName: "everything-local-tls",
    });
    assert.match(host.read(host.log), /--namespace local/);
    // Everything's upgrades reuse the same settings.
    assert.equal(host.read(`${host.log}.upgrade-settings`), saved);
  });

  test("leaves a preset's public apps settings out for a chart from before them, on every run", async () => {
    const preset = writeLocalPreset();
    const result = join(host.directory, "result");
    const env = {
      EVERYTHING_VERSION: legacy,
      EVERYTHING_PRESET_SETTINGS: preset,
      EVERYTHING_SETTINGS_FILE: settings,
      EVERYTHING_RESULT_FILE: result,
    };
    writeFileSync(result, "");
    let run = await runInstaller(["", "", "db-password", "", "y"], env);
    assert.equal(run.status, 0, run.output);
    const saved = readFileSync(settings, "utf8");
    assert.deepEqual(publicAppsSettings(saved), []);
    // Everything else the preset holds is kept.
    const global = globals(saved);
    assert.equal(global.externalHostname, "everything.internal");
    assert.equal(
      global.externalArtifactHostname,
      "artifacts.everything.internal",
    );
    assert.equal(global.externalRegistryHostname, "images.everything.internal");
    assert.equal(global.storageClassName, "local-path");
    for (const site of ["ingress", "artifactIngress", "registryIngress"])
      assert.deepEqual(
        global[site],
        {
          className: "traefik",
          annotations: {
            "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
          },
          tlsSecretName: "everything-local-tls",
        },
        site,
      );
    assert.match(saved, /^  voice-asr:\n {4}enabled: false$/m);
    for (const command of ["template", "upgrade"] as const)
      for (const values of givenSettings(command))
        assert.deepEqual(publicAppsSettings(values), [], command);
    assert.equal(host.read(`${host.log}.upgrade-settings`), saved);
    // The caller learns the chart serves no public apps.
    assert.equal(readFileSync(result, "utf8"), "");

    // A rerun with the same preset and chart changes nothing and installs again.
    writeFileSync(host.log, "");
    writeFileSync(`${host.log}.upgrade-values`, "");
    run = await runInstaller(["", "", "", "y"], env);
    assert.equal(run.status, 0, run.output);
    assert.ok(!run.output.includes("Saved the settings"));
    assert.equal(readFileSync(settings, "utf8"), saved);
    assert.match(host.read(host.log), /helm upgrade everything/);
    for (const values of givenSettings("upgrade"))
      assert.deepEqual(publicAppsSettings(values), []);
    assert.equal(readFileSync(result, "utf8"), "");
  });

  test("refuses to take saved public apps settings to a chart from before them, leaving the file unchanged", async () => {
    const saved = legacySettings.replace(
      "  externalRegistryHostname:",
      [
        "  externalPublicAppsHostname: 'public-apps.example.com'",
        "  publicAppsIngress:",
        "    className: 'nginx'",
        "    tlsSecretName: 'everything-public-apps-tls'",
        "  externalRegistryHostname:",
      ].join("\n"),
    );
    for (const variant of [
      saved,
      // Any one of them is a setting the older chart refuses.
      legacySettings.replace(
        "  storageClassName: ''",
        "  storageClassName: ''\n  publicAppsIngress:\n    className: ''",
      ),
      legacySettings.replace(
        "  storageClassName: ''",
        "  storageClassName: ''\n  publicAppsOrigin: 'https://public-apps.example.com'",
      ),
    ]) {
      writeFileSync(settings, variant);
      const modified = statSync(settings).mtimeMs;
      writeFileSync(host.log, "");
      const result = await runInstaller([settings, "", "", "y"], {
        EVERYTHING_VERSION: legacy,
        EVERYTHING_PRESET_SETTINGS: writeLocalPreset(),
      });
      assert.equal(result.status, 1, result.output);
      assert.match(
        result.output,
        new RegExp(
          `${settings} has settings for public apps, which version ${legacy.replaceAll(".", "\\.")} of Everything does not have\\. Choose a version with public apps, or another settings file; ${settings} is unchanged\\.`,
        ),
      );
      assert.equal(readFileSync(settings, "utf8"), variant);
      assert.equal(statSync(settings).mtimeMs, modified);
      assert.doesNotMatch(host.read(host.log), /helm (template|upgrade)/);
    }
  });

  test("fills the public apps host's Ingress from the artifact host's when settings saved before public apps meet a chart with them", async () => {
    writeFileSync(settings, legacySettings);
    const result = await runInstaller([settings, "", "", "", "y"]);
    assert.equal(result.status, 0, result.output);
    assert.match(
      result.output,
      /Your settings file lacks some settings this version uses; the rest are kept\./,
    );
    assert.ok(result.output.includes("Hostname for public apps"));
    for (const question of [
      "ingress class",
      "ClusterIssuer",
      "storage class",
      "Hostname for apps",
      "Size of the disk",
      "PostgreSQL superuser password",
    ])
      assert.ok(!result.output.includes(question), question);
    const saved = readFileSync(settings, "utf8");
    const global = globals(saved);
    assert.equal(global.externalPublicAppsHostname, "public-apps.example.com");
    assert.deepEqual(global.publicAppsIngress, {
      className: "nginx",
      annotations: { "cert-manager.io/cluster-issuer": "letsencrypt" },
      tlsSecretName: "everything-public-apps-tls",
    });
    // The rest is as it was saved.
    assert.deepEqual(
      { ...parse(saved), global: { ...global } },
      (() => {
        const before = parse(legacySettings) as Record<string, unknown> & {
          global: Record<string, unknown>;
        };
        return {
          ...before,
          global: {
            ...before.global,
            externalPublicAppsHostname: "public-apps.example.com",
            publicAppsIngress: global.publicAppsIngress,
          },
        };
      })(),
    );
    assert.equal(host.read(`${host.log}.upgrade-settings`), saved);
    for (const command of ["template", "upgrade"] as const)
      assert.deepEqual(publicAppsSettings(givenSettings(command).at(-1)!), [
        "externalPublicAppsHostname",
        "publicAppsIngress",
      ]);
  });

  test("keeps the public apps host's own saved settings and fills only what they lack", async () => {
    writeFileSync(
      settings,
      legacySettings.replace(
        "  storageClassName: ''",
        [
          "  storageClassName: ''",
          "  externalPublicAppsHostname: 'apps.example.com'",
          "  publicAppsIngress:",
          "    className: 'public-class'",
        ].join("\n"),
      ),
    );
    const result = await runInstaller([settings, "", "", "y"]);
    assert.equal(result.status, 0, result.output);
    assert.ok(!result.output.includes("Hostname for public apps"));
    const global = globals(readFileSync(settings, "utf8"));
    assert.equal(global.externalPublicAppsHostname, "apps.example.com");
    assert.deepEqual(global.publicAppsIngress, {
      className: "public-class",
      annotations: { "cert-manager.io/cluster-issuer": "letsencrypt" },
      tlsSecretName: "everything-public-apps-tls",
    });

    // Without an issuer for the artifact host, the public apps host leaves TLS to the controller too.
    writeFileSync(
      settings,
      legacySettings.replaceAll(
        "      cert-manager.io/cluster-issuer: 'letsencrypt'\n",
        "",
      ),
    );
    const plain = await runInstaller([settings, "", "", "", "y"]);
    assert.equal(plain.status, 0, plain.output);
    assert.deepEqual(
      globals(readFileSync(settings, "utf8")).publicAppsIngress,
      {
        className: "nginx",
        tlsSecretName: "",
      },
    );
  });

  test("keeps public apps on a hostname of their own, whatever its case or trailing dot", async () => {
    const result = await runInstaller([
      settings,
      "",
      "everything",
      "everything.example.com",
      "",
      "ARTIFACTS.example.com",
      "Everything.Example.com",
      "",
      "",
      "",
      "",
      "",
      "db-password",
      "",
      "y",
    ]);
    assert.equal(result.status, 0, result.output);
    assert.equal(
      result.output.match(/Public apps need a hostname of their own/g)?.length,
      2,
    );
    assert.equal(
      globals(readFileSync(settings, "utf8")).externalPublicAppsHostname,
      "public-apps.example.com",
    );

    // Saved settings that share a hostname are refused before anything changes.
    for (const shared of [
      "Artifacts.Example.com.",
      "everything.example.com.",
    ]) {
      const saved = legacySettings.replace(
        "  storageClassName: ''",
        `  storageClassName: ''\n  externalPublicAppsHostname: '${shared}'`,
      );
      writeFileSync(settings, saved);
      writeFileSync(host.log, "");
      const refused = await runInstaller([settings, "", "", "y"]);
      assert.equal(refused.status, 1, refused.output);
      assert.match(
        refused.output,
        /browsers share a hostname's cookies across its ports, so public apps need one of their own/,
      );
      assert.equal(readFileSync(settings, "utf8"), saved);
      assert.doesNotMatch(host.read(host.log), /helm upgrade/);
    }
  });

  test("keeps saved settings over a preset's", async () => {
    writeFileSync(
      settings,
      "# namespace: kept\nglobal:\n  externalHostname: 'saved.example.com'\n  externalPublicAppsHostname: 'public.saved.example.com'\n",
    );
    const preset = join(host.directory, "preset.yaml");
    writeFileSync(
      preset,
      "# namespace: local\nglobal:\n  externalHostname: 'everything.internal'\n  externalArtifactHostname: 'artifacts.example.com'\n  externalPublicAppsHostname: 'public-apps.example.com'\n  externalRegistryHostname: 'images.example.com'\n  ingress:\n    className: ''\n    tlsSecretName: ''\n  storageClassName: ''\n",
    );
    const result = await runInstaller([settings, "", "", "", "", "y"], {
      EVERYTHING_PRESET_SETTINGS: preset,
    });
    assert.equal(result.status, 0, result.output);
    const saved = readFileSync(settings, "utf8");
    assert.match(saved, /^# namespace: kept$/m);
    assert.match(saved, /^  externalHostname: 'saved\.example\.com'$/m);
    assert.match(
      saved,
      /^  externalArtifactHostname: 'artifacts\.example\.com'$/m,
    );
    assert.match(
      saved,
      /^  externalPublicAppsHostname: 'public\.saved\.example\.com'$/m,
    );
  });

  test("tells its caller when the person declines to install, and whether the chart serves public apps", async () => {
    const result = join(host.directory, "result");
    const preset = writeLocalPreset();
    const env = {
      EVERYTHING_PRESET_SETTINGS: preset,
      EVERYTHING_SETTINGS_FILE: settings,
      EVERYTHING_RESULT_FILE: result,
    };
    writeFileSync(result, "");
    let run = await runInstaller(["", "", "", "", "n"], env);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /Nothing installed/);
    assert.equal(readFileSync(result, "utf8"), "declined\n");
    assert.doesNotMatch(host.read(host.log), /helm upgrade/);

    // Installing a chart with public apps says so; a chart from before them leaves the file empty.
    writeFileSync(result, "");
    run = await runInstaller(["", "", "", "y"], env);
    assert.equal(run.status, 0, run.output);
    assert.match(host.read(host.log), /helm upgrade/);
    assert.equal(readFileSync(result, "utf8"), "public-apps\n");
  });

  test("refuses a preset it cannot read", async () => {
    const result = await runInstaller([settings, ""], {
      EVERYTHING_PRESET_SETTINGS: join(host.directory, "missing.yaml"),
    });
    assert.equal(result.status, 1);
    assert.match(result.output, /Cannot read the preset settings/);
  });
});
