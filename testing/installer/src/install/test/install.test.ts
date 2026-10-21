import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  FakeHost,
  executable,
  scriptDirectory,
} from "../../local/fixture/fake-host.js";

let host: FakeHost;
let chart: string;
let settings: string;

/** A chart with one credential and one disk, as `helm pull` would download it. */
function writeChart(): void {
  const source = join(host.directory, "chart-source/everything");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "Chart.yaml"),
    "name: everything\nversion: 9.9.9\n",
  );
  writeFileSync(
    join(source, "values.yaml"),
    'global: {}\nsecrets:\n  database-credentials:\n    admin: ""\nother: {}\n',
  );
  writeFileSync(join(source, "values.prod.yaml"), "global: {}\n");
  chart = join(host.directory, "everything-9.9.9.tgz");
  execFileSync("tar", [
    "-czf",
    chart,
    "-C",
    join(host.directory, "chart-source"),
    "everything",
  ]);
}

beforeEach(() => {
  host = new FakeHost();
  writeChart();
  settings = join(host.directory, "settings.yaml");
  // Helm downloads the chart, renders one disk, and installs; Keycloak never becomes ready, so the
  // installer skips the first user.
  executable(
    join(host.bin, "helm"),
    `#!/bin/bash
printf 'helm %s\\n' "$*" >> "$FAKE_LOG"
case $1 in
  show) echo "version: 9.9.9" ;;
  pull) while [ $# -gt 0 ]; do if [ "$1" = --destination ]; then cp ${JSON.stringify(chart)} "$2/"; fi; shift; done ;;
  template) printf -- '---\\nkind: PersistentVolumeClaim\\nmetadata:\\n  name: postgres-data\\n  labels:\\n    app.kubernetes.io/name: postgres\\nspec:\\n  resources:\\n    requests:\\n      storage: "20Gi"\\n' ;;
  status) exit 1 ;;
  upgrade) for a in "$@"; do case $a in upgrades.settings=*) cp "\${a#upgrades.settings=}" "$FAKE_LOG.upgrade-settings" ;; esac; done ;;
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
    env: { EVERYTHING_VERSION: "9.9.9", ...env },
  });
}

describe("install.sh", () => {
  test("asks for every cluster setting without a preset, as before", async () => {
    const result = await runInstaller([
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
    ]);
    assert.equal(result.status, 0, result.output);
    for (const question of [
      "Namespace to install into",
      "Hostname the application is served on",
      "Hostname for apps",
      "Hostname of the image registry",
      "ingress class",
      "ClusterIssuer",
      "storage class",
    ]) {
      assert.ok(result.output.includes(question), question);
    }
    assert.match(result.output, /Point DNS for everything\.example\.com/);
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
      /^      nginx\.ingress\.kubernetes\.io\/proxy-body-size: '0'$/m,
    );
    assert.match(
      saved,
      /^      cert-manager\.io\/cluster-issuer: 'letsencrypt'$/m,
    );
    assert.match(saved, /^    admin: 'db-password'$/m);
    assert.match(
      host.read(host.log),
      /helm upgrade everything .* --kube-context test-context --namespace everything/,
    );
  });

  test("takes a preset's settings and namespace, and leaves DNS to its caller", async () => {
    const preset = join(host.directory, "preset.yaml");
    writeFileSync(
      preset,
      [
        "# namespace: local",
        "global:",
        "  externalHostname: 'everything.internal'",
        "  externalArtifactHostname: 'artifacts.everything.internal'",
        "  externalRegistryHostname: 'images.everything.internal'",
        "  ingress:",
        "    className: 'traefik'",
        "    tlsSecretName: 'everything-local-tls'",
        "  storageClassName: 'local-path'",
        "services:",
        "  voice-asr:",
        "    enabled: false",
        "",
      ].join("\n"),
    );
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
    assert.match(host.read(host.log), /--namespace local/);
    // Everything's upgrades reuse the same settings.
    assert.equal(host.read(`${host.log}.upgrade-settings`), saved);
  });

  test("keeps saved settings over a preset's", async () => {
    writeFileSync(
      settings,
      "# namespace: kept\nglobal:\n  externalHostname: 'saved.example.com'\n",
    );
    const preset = join(host.directory, "preset.yaml");
    writeFileSync(
      preset,
      "# namespace: local\nglobal:\n  externalHostname: 'everything.internal'\n  externalArtifactHostname: 'artifacts.example.com'\n  externalRegistryHostname: 'images.example.com'\n  ingress:\n    className: ''\n    tlsSecretName: ''\n  storageClassName: ''\n",
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
  });

  test("refuses a preset it cannot read", async () => {
    const result = await runInstaller([settings, ""], {
      EVERYTHING_PRESET_SETTINGS: join(host.directory, "missing.yaml"),
    });
    assert.equal(result.status, 1);
    assert.match(result.output, /Cannot read the preset settings/);
  });
});
