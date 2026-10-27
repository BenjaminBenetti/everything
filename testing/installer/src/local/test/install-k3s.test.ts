import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { FakeHost, sha256 } from "../fixture/fake-host.js";

let host: FakeHost;

beforeEach(() => {
  host = new FakeHost();
});

afterEach(() => {
  host.dispose();
});

/** Run the source copy with the fake installer, agreeing to the plan. */
function install(
  options: { env?: Record<string, string>; answers?: string[] } = {},
) {
  return host.run({
    args: ["--installer", host.fakeInstaller],
    answers: options.answers ?? ["y", "installer answer"],
    ...(options.env ? { env: options.env } : {}),
  });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

const ownedMarker =
  "# Written by Everything's local installer (install-k3s.sh).";

/** Lay down an owned k3s, as a finished earlier run leaves it. */
async function installOnce(): Promise<void> {
  const result = await install();
  assert.equal(result.status, 0, result.output);
  writeFileSync(host.log, "");
}

describe("before changing anything", () => {
  test("prints help without a terminal", async () => {
    const result = await host.run({ args: ["--help"], noTerminal: true });
    assert.equal(result.status, 0);
    assert.match(result.output, /--remove-trust/);
    assert.match(result.output, /k3s-uninstall\.sh/);
  });

  test("needs a terminal for its questions", async () => {
    const result = await host.run({
      args: ["--installer", host.fakeInstaller],
      noTerminal: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.output, /run it from a terminal/);
    assert.deepEqual(host.calls(), []);
  });

  for (const [name, env, message] of [
    ["another operating system", { FAKE_UNAME_S: "Darwin" }, /Linux only/],
    [
      "an unsupported architecture",
      { FAKE_UNAME_M: "riscv64" },
      /x86-64 and ARM64/,
    ],
    [
      "a run through sudo",
      { FAKE_UID: "0", SUDO_USER: "tester" },
      /not with sudo/,
    ],
  ] as const) {
    test(`refuses ${name}`, async () => {
      const result = await install({ env: { ...env } });
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, message);
      assert.equal(
        host.calls().filter((call) => call.name === "sudo").length,
        0,
      );
    });
  }

  test("refuses WSL", async () => {
    writeFileSync(
      join(host.root, "proc/sys/kernel/osrelease"),
      "5.15.0-microsoft-standard-WSL2\n",
    );
    const result = await install();
    assert.equal(result.status, 1);
    assert.match(result.output, /not WSL/);
  });

  test("refuses a computer without systemd", async () => {
    execFileSync("rm", ["-r", join(host.root, "run/systemd")]);
    const result = await install();
    assert.equal(result.status, 1);
    assert.match(result.output, /needs systemd/);
  });

  test("refuses a computer with too little memory", async () => {
    writeFileSync(
      join(host.root, "proc/meminfo"),
      "MemTotal:        4000000 kB\n",
    );
    const result = await install();
    assert.equal(result.status, 1);
    assert.match(result.output, /at least 8 GB of memory/);
  });

  test("names the release it installs, or the installer from source", async () => {
    const result = await host.run({ answers: ["y"] });
    assert.equal(result.status, 1);
    assert.match(result.output, /names no release/);
    assert.match(result.output, /--installer deployment\/script\/install\.sh/);
  });

  for (const path of [
    "usr/local/bin/k3s",
    "etc/systemd/system/k3s-agent.service",
    "etc/rancher/k3s",
    "var/lib/rancher/rke2",
  ]) {
    test(`refuses a Kubernetes it did not install: /${path}`, async () => {
      mkdirSync(join(host.root, path, ".."), { recursive: true });
      writeFileSync(join(host.root, path), "");
      const before = host.files().map((file) => [file, host.read(file)]);
      const result = await install();
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /did not make/);
      assert.equal(
        host.calls().filter((call) => call.name === "sudo").length,
        0,
      );
      assert.deepEqual(
        host.files().map((file) => [file, host.read(file)]),
        before,
      );
    });
  }

  test("refuses a k3s agent beside its own k3s", async () => {
    await installOnce();
    writeFileSync(join(host.root, "etc/systemd/system/k3s-agent.service"), "");
    const result = await install();
    assert.equal(result.status, 1);
    assert.match(result.output, /k3s agent/);
  });

  test("refuses a registries.yaml someone else wrote in its k3s", async () => {
    await installOnce();
    writeFileSync(
      join(host.root, "etc/rancher/k3s/registries.yaml"),
      "mirrors: {}\n",
    );
    const result = await install();
    assert.equal(result.status, 1);
    assert.match(result.output, /registries\.yaml was not written/);
    assert.equal(
      host.read(join(host.root, "etc/rancher/k3s/registries.yaml")),
      "mirrors: {}\n",
    );
  });

  for (const port of ["443", "6443", "10250"]) {
    test(`refuses a fresh install while port ${port} is in use`, async () => {
      const result = await install({ env: { FAKE_PORTS_IN_USE: port } });
      assert.equal(result.status, 1);
      assert.match(result.output, new RegExp(`Port ${port} is in use`));
      assert.equal(
        host.calls().filter((call) => call.name === "sudo").length,
        0,
      );
    });
  }

  test("refuses a hosts file that is a symbolic link", async () => {
    const hosts = join(host.root, "etc/hosts");
    const target = join(host.directory, "hosts.real");
    writeFileSync(target, host.read(hosts));
    execFileSync("rm", [hosts]);
    symlinkSync(target, hosts);
    const result = await install();
    assert.equal(result.status, 1);
    assert.match(result.output, /symbolic link/);
  });

  test("refuses a hosts file that maps a local name elsewhere", async () => {
    writeFileSync(
      join(host.root, "etc/hosts"),
      "127.0.0.1 localhost\n10.0.0.9 everything.internal\n",
    );
    const result = await install();
    assert.equal(result.status, 1);
    assert.match(result.output, /already maps everything\.internal/);
  });

  test("refuses a private folder that is a symbolic link", async () => {
    mkdirSync(join(host.home, ".local/share"), { recursive: true });
    mkdirSync(join(host.directory, "elsewhere"));
    symlinkSync(join(host.directory, "elsewhere"), host.stateDirectory);
    const result = await install();
    assert.equal(result.status, 1);
    assert.match(result.output, /symbolic link/);
  });

  test("changes nothing when the plan is declined", async () => {
    const result = await install({ answers: ["n"] });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Nothing changed/);
    assert.match(result.output, /\/etc\/hosts/);
    assert.equal(host.calls().filter((call) => call.name === "sudo").length, 0);
    assert.equal(existsSync(host.stateDirectory), false);
  });

  test("stops when sudo is refused", async () => {
    const result = await install({ env: { FAKE_SUDO_STATUS: "1" } });
    assert.equal(result.status, 1);
    assert.match(result.output, /sudo did not grant root access/);
  });
});

describe("a fresh installation", () => {
  test("installs k3s, trusts the local authority, and runs the installer against the private kubeconfig", async () => {
    mkdirSync(join(host.home, ".kube"));
    const userKubeconfig = join(host.home, ".kube/config");
    writeFileSync(userKubeconfig, "current-context: remote\n");
    const result = await install();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /installer read: installer answer/);
    assert.match(result.output, /Open https:\/\/everything\.internal/);

    const state = host.stateDirectory;
    const kubeconfig = join(state, "kubeconfig");
    assert.equal(host.read(userKubeconfig), "current-context: remote\n");
    assert.equal(mode(state), 0o700);
    assert.equal(mode(kubeconfig), 0o600);
    assert.match(host.read(kubeconfig), /^current-context: everything-local$/m);
    assert.doesNotMatch(host.read(kubeconfig), /: default$/m);

    // Every cluster command names the private kubeconfig and its context.
    const clusterCalls = host
      .calls()
      .filter((call) => call.name === "kubectl" || call.name === "helm")
      .filter((call) => call.args[0] !== "version");
    assert.ok(clusterCalls.length > 5);
    for (const call of clusterCalls) {
      const joined = call.args.join(" ");
      assert.match(joined, new RegExp(`--kubeconfig ${kubeconfig}`), joined);
      assert.match(joined, /--(kube-)?context everything-local/, joined);
    }
    // Readiness checks give up on an API server that accepts connections but does not answer.
    const readiness = clusterCalls.filter((call) =>
      call.args.includes("--raw=/readyz"),
    );
    assert.ok(readiness.length > 0);
    for (const call of readiness)
      assert.ok(call.args.includes("--request-timeout=20s"));
    const installerEnv = host.read(host.installerLog);
    assert.match(installerEnv, new RegExp(`^KUBECONFIG=${kubeconfig}$`, "m"));
    assert.match(
      installerEnv,
      new RegExp(
        `^EVERYTHING_SETTINGS_FILE=${state}/everything-values.yaml$`,
        "m",
      ),
    );

    // Root runs only system changes; certificates, browsers, and the cluster run as the user.
    const rootCommands = host.rootCommands().map((command) => command[0]);
    for (const command of rootCommands) {
      assert.ok(
        [
          "install",
          "cmp",
          "test",
          "cp",
          "mktemp",
          "sync",
          "chmod",
          "mv",
          "env",
          "update-ca-certificates",
          "cat",
        ].includes(command ?? ""),
        `unexpected root command ${command}`,
      );
    }
    assert.ok(
      host
        .rootCommands()
        .some(
          (command) =>
            command.includes("INSTALL_K3S_VERSION=v1.36.5+k3s1") &&
            command.includes("INSTALL_K3S_SYMLINK=skip"),
        ),
    );
    for (const name of ["openssl", "certutil", "kubectl", "helm"]) {
      assert.ok(!rootCommands.includes(name), `${name} ran as root`);
    }
  });

  test("keeps the authority's private key in its folder and the certificate's key in its Secret", async () => {
    const result = await install();
    assert.equal(result.status, 0, result.output);
    const ca = join(host.stateDirectory, "ca");
    assert.equal(mode(ca), 0o700);
    assert.equal(mode(join(ca, "ca-key.pem")), 0o600);
    assert.equal(mode(join(host.stateDirectory, "tls/tls.key")), 0o600);
    const caKey = keyBody(host.read(join(ca, "ca-key.pem")));
    const leafKey = keyBody(
      host.read(join(host.stateDirectory, "tls/tls.key")),
    );

    // Nothing outside the authority's folder holds its key: not the system, the cluster, the
    // installer, or the terminal.
    const elsewhere = [
      ...host.files(host.root),
      ...host.files(host.temp),
      host.applied,
      host.installerLog,
      host.log,
    ];
    for (const file of elsewhere) {
      assert.ok(
        !host.read(file).includes(caKey),
        `${file} holds the authority's key`,
      );
    }
    assert.ok(!result.output.includes(caKey));
    // The certificate's key goes only to the TLS Secret.
    const documents = host.read(host.applied).split("# applied\n");
    const withLeafKey = documents.filter((document) =>
      document.includes(leafKey),
    );
    assert.equal(withLeafKey.length, 1);
    assert.match(withLeafKey[0] ?? "", /--key/);
    for (const file of host.files(host.root)) {
      assert.ok(
        !host.read(file).includes(leafKey),
        `${file} holds the certificate's key`,
      );
    }
    assert.ok(!result.output.includes(leafKey));
    // The temporary folder is gone.
    assert.deepEqual(readdirSync(host.temp), []);
  });

  test("makes an authority that signs only the local names, and a certificate for all three", async () => {
    const result = await install();
    assert.equal(result.status, 0, result.output);
    const ca = join(host.stateDirectory, "ca/ca.pem");
    const leaf = join(host.stateDirectory, "tls/tls.crt");
    const caText = execFileSync(
      "openssl",
      ["x509", "-in", ca, "-noout", "-text"],
      {
        encoding: "utf8",
      },
    );
    assert.match(
      caText,
      /X509v3 Name Constraints: critical\s+Permitted:\s+DNS:everything\.internal/,
    );
    assert.match(caText, /CA:TRUE, pathlen:0/);
    const leafText = execFileSync(
      "openssl",
      ["x509", "-in", leaf, "-noout", "-text"],
      {
        encoding: "utf8",
      },
    );
    assert.match(
      leafText,
      /DNS:everything\.internal, DNS:artifacts\.everything\.internal, DNS:public-apps\.everything\.internal, DNS:images\.everything\.internal/,
    );
    execFileSync("openssl", ["verify", "-CAfile", ca, leaf]);
    // A name outside the constraint fails even when the authority's key signs it.
    const outside = join(host.directory, "outside.crt");
    const outsideKey = join(host.directory, "outside.key");
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-subj",
        "/CN=example.com",
        "-keyout",
        outsideKey,
        "-out",
        `${outside}.csr`,
      ],
      { stdio: "ignore" },
    );
    writeFileSync(`${outside}.ext`, "subjectAltName = DNS:example.com\n");
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        `${outside}.csr`,
        "-CA",
        ca,
        "-CAkey",
        join(host.stateDirectory, "ca/ca-key.pem"),
        "-set_serial",
        "7",
        "-days",
        "1",
        "-extfile",
        `${outside}.ext`,
        "-out",
        outside,
      ],
      { stdio: "ignore" },
    );
    assert.throws(() =>
      execFileSync("openssl", ["verify", "-CAfile", ca, outside], {
        stdio: "pipe",
      }),
    );
    // Nor can it sign for an IP address.
    writeFileSync(`${outside}.ext`, "subjectAltName = IP:192.168.1.1\n");
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        `${outside}.csr`,
        "-CA",
        ca,
        "-CAkey",
        join(host.stateDirectory, "ca/ca-key.pem"),
        "-set_serial",
        "8",
        "-days",
        "1",
        "-extfile",
        `${outside}.ext`,
        "-out",
        outside,
      ],
      { stdio: "ignore" },
    );
    assert.throws(() =>
      execFileSync("openssl", ["verify", "-CAfile", ca, outside], {
        stdio: "pipe",
      }),
    );
  });

  test("trusts the authority system-wide and in browser databases", async () => {
    const profile = join(host.home, ".mozilla/firefox/abc.default");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "cert9.db"), "");
    const result = await install();
    assert.equal(result.status, 0, result.output);
    const anchors = readdirSync(
      join(host.root, "usr/local/share/ca-certificates"),
    );
    assert.equal(anchors.length, 1);
    assert.match(anchors[0] ?? "", /^everything-local-ca-[0-9a-f]{16}\.crt$/);
    assert.equal(
      host.read(
        join(host.root, "usr/local/share/ca-certificates", anchors[0] ?? ""),
      ),
      host.read(join(host.stateDirectory, "ca/ca.pem")),
    );
    assert.ok(
      host.calls().some((call) => call.name === "update-ca-certificates"),
    );
    for (const database of [join(host.home, ".pki/nssdb"), profile]) {
      assert.match(
        host.read(join(database, "nicknames")),
        /^Everything local CA [0-9a-f]{16}$/m,
      );
    }
  });

  test("configures k3s, the hosts file, and the cluster's DNS and Traefik", async () => {
    const result = await install();
    assert.equal(result.status, 0, result.output);
    const k3s = join(host.root, "etc/rancher/k3s");
    assert.match(
      host.read(join(k3s, "config.yaml.d/50-everything-local.yaml")),
      /- servicelb/,
    );
    const registries = host.read(join(k3s, "registries.yaml"));
    assert.match(registries, /"images\.everything\.internal":/);
    assert.match(
      registries,
      /ca_file: \/etc\/rancher\/k3s\/everything-local-ca\.pem/,
    );
    assert.doesNotMatch(registries, /insecure_skip_verify|skip_verify/);
    assert.equal(
      host.read(join(k3s, "everything-local-ca.pem")),
      host.read(join(host.stateDirectory, "ca/ca.pem")),
    );
    const manifests = join(host.root, "var/lib/rancher/k3s/server/manifests");
    const traefik = host.read(join(manifests, "everything-local-traefik.yaml"));
    assert.match(traefik, /hostPort: 443\n\s+hostIP: 127\.0\.0\.1/);
    assert.match(traefik, /type: ClusterIP/);
    assert.match(traefik, /--entryPoints\.websecure\.address=:8443\/tcp/);
    assert.match(
      host.read(join(manifests, "everything-local-coredns.yaml")),
      /rewrite name regex \^\(everything\|artifacts\\\.everything\|public-apps\\\.everything\|images\\\.everything\)\\\.internal\\\.\?\$ traefik\.kube-system\.svc\.cluster\.local\. answer auto/,
    );
    const hosts = host.read(join(host.root, "etc/hosts"));
    assert.match(hosts, /^127\.0\.0\.1\tlocalhost$/m);
    assert.match(
      hosts,
      /# BEGIN Everything local installer \(install-k3s\.sh\)\n127\.0\.0\.1\teverything\.internal artifacts\.everything\.internal public-apps\.everything\.internal images\.everything\.internal\n# END Everything local installer\n$/,
    );
    const backups = readdirSync(join(host.root, "etc")).filter((name) =>
      name.startsWith("hosts.everything-local-"),
    );
    assert.equal(backups.length, 1);
  });

  test("presets the local hostnames, TLS, storage, and trust for the installer", async () => {
    const result = await install();
    assert.equal(result.status, 0, result.output);
    const preset = host.read(`${host.installerLog}.preset`);
    assert.match(preset, /^# namespace: everything$/m);
    for (const line of [
      "  externalHostname: 'everything.internal'",
      "  externalArtifactHostname: 'artifacts.everything.internal'",
      "  externalPublicAppsHostname: 'public-apps.everything.internal'",
      "  externalRegistryHostname: 'images.everything.internal'",
      "    className: 'traefik'",
      "    tlsSecretName: 'everything-local-tls'",
      "      traefik.ingress.kubernetes.io/router.entrypoints: 'websecure'",
      "  storageClassName: 'local-path'",
      "      SSL_CERT_DIR: '/etc/ssl/certs:/etc/everything-local-ca'",
      "        secret: 'everything-local-ca'",
      "          local-ca: '/etc/docker/certs.d/images.everything.internal'",
    ]) {
      assert.ok(preset.includes(`${line}\n`), line);
    }
    assert.doesNotMatch(preset, /insecure|INSECURE/i);
    assert.doesNotMatch(preset, /voice-asr/);
    // The namespace and both Secrets exist before the installer runs.
    const applied = host.read(host.applied);
    assert.match(applied, /pod-security\.kubernetes\.io\/enforce: privileged/);
    assert.match(applied, /ca\.crt: \|/);
    assert.match(applied, /[0-9a-f]{8}\.0: \|/);
  });

  test("turns voice input off on ARM64, where its speech service cannot run", async () => {
    const result = await install({ env: { FAKE_UNAME_M: "aarch64" } });
    assert.equal(result.status, 0, result.output);
    assert.match(
      host.read(`${host.installerLog}.preset`),
      /  voice-asr:\n    enabled: false\n/,
    );
    assert.match(result.output, /Voice input is off/);
  });

  test("runs when piped to Bash, reading answers from the terminal", async () => {
    const result = await host.run({
      args: ["--installer", host.fakeInstaller],
      answers: ["y", "installer answer"],
      piped: true,
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /installer read: installer answer/);
  });

  test("installs packages it lacks with consent", async () => {
    host.removeCommand("certutil");
    const result = await install();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /install libnss3-tools with apt-get/);
    assert.ok(
      host
        .rootCommands()
        .some(
          (command) =>
            command.includes("apt-get") && command.includes("libnss3-tools"),
        ),
    );
  });

  test("downloads the pinned Helm when this computer's is too old", async () => {
    const tarball = join(host.directory, "helm.tar.gz");
    mkdirSync(join(host.directory, "helm/linux-amd64"), { recursive: true });
    writeFileSync(
      join(host.directory, "helm/linux-amd64/helm"),
      '#!/bin/bash\nif [ "$1" = version ]; then echo v4.3.0; exit; fi\nexit "${FAKE_HELM_STATUS:-0}"\n',
      { mode: 0o755 },
    );
    execFileSync("tar", [
      "-czf",
      tarball,
      "-C",
      join(host.directory, "helm"),
      "linux-amd64",
    ]);
    const source = readFileSync(host.script, "utf8").replace(
      /amd64\) echo [0-9a-f]{64}/,
      `amd64) echo ${sha256(readFileSync(tarball))}`,
    );
    host.prepareScript(source);
    host.setDownloads({
      "https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz": tarball,
    });
    const result = await install({ env: { FAKE_HELM_VERSION: "v3.7.0" } });
    assert.equal(result.status, 0, result.output);
    const privateHelm = join(host.stateDirectory, "bin/helm");
    assert.ok(existsSync(privateHelm));
    assert.match(
      host.read(host.installerLog),
      new RegExp(`^PATH=${host.stateDirectory}/bin:`, "m"),
    );
  });
});

describe("failures", () => {
  test("refuses a download whose digest differs, before changing anything as root", async () => {
    host.prepareScript(undefined, { k3s_install_sha256: "0".repeat(64) });
    const hosts = host.read(join(host.root, "etc/hosts"));
    const result = await install();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /not the expected 0{64}; it was not used/);
    assert.match(result.output, /stopped while installing tools/);
    assert.deepEqual(host.rootCommands(), []);
    assert.equal(host.read(join(host.root, "etc/hosts")), hosts);
    assert.deepEqual(
      readdirSync(join(host.root, "usr/local/share/ca-certificates")),
      [],
    );
    assert.deepEqual(readdirSync(host.temp), []);
  });

  test("stops when a download fails", async () => {
    host.prepareScript(undefined, {
      k3s_install_url: "https://example.invalid/missing.sh",
    });
    writeFileSync(host.downloads, "");
    const result = await install();
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /Could not download https:\/\/example\.invalid\/missing\.sh/,
    );
  });

  test("bounds the wait for the cluster", async () => {
    const result = await install({ env: { FAKE_READYZ_STATUS: "1" } });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /Timed out after 20s waiting for the Kubernetes API/,
    );
    assert.match(result.output, /rerun it to continue/);
  });

  test("refuses a Traefik published beyond loopback", async () => {
    const result = await install({ env: { FAKE_TRAEFIK_HOST_IP: "" } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Traefik's loopback port/);
  });

  test("passes on the installer's failure", async () => {
    const result = await install({ env: { FAKE_INSTALLER_STATUS: "7" } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /installer stopped with status 7/);
    assert.match(result.output, /stopped while installing Everything/);
  });

  test("leaves without error when the person declined to install", async () => {
    const result = await install({
      env: { FAKE_INSTALLER_DECLINE: "1", FAKE_HELM_STATUS: "1" },
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /was not installed or upgraded, as you chose/);
    assert.ok(
      !host
        .calls()
        .some((call) => call.name === "helm" && call.args[0] === "status"),
    );
  });

  test("fails when Helm cannot find the release after the installer succeeded", async () => {
    const result = await install({ env: { FAKE_HELM_STATUS: "7" } });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /Helm could not find its release: Error: Kubernetes cluster unreachable: connection refused/,
    );
    assert.match(result.output, /stopped while installing Everything/);
    assert.doesNotMatch(result.output, /Everything is running/);
  });

  test("fails when a name does not answer with a trusted certificate", async () => {
    host.setEndpoints({
      "https://everything.internal/health/ready": "200",
      "https://artifacts.everything.internal/": "404",
      "https://public-apps.everything.internal/": "404",
    });
    const result = await install();
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /images\.everything\.internal\/v2\/ did not answer with a trusted certificate/,
    );
  });

  test("fails when Everything is not healthy", async () => {
    host.setEndpoints({
      "https://everything.internal/health/ready": "503",
      "https://artifacts.everything.internal/": "404",
      "https://images.everything.internal/v2/": "401",
    });
    const result = await install();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /health\/ready answered HTTP 503/);
  });

  test("stops on a signal, with its exit status and how to continue", async () => {
    const pidFile = join(host.directory, "installer.pid");
    const run = host.run({
      args: ["--installer", host.fakeInstaller],
      answers: ["y"],
      env: { FAKE_HANG_READYZ: pidFile },
    });
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) || host.read(pidFile).trim() === "") {
      if (Date.now() > deadline)
        throw new Error("the installer never waited for the cluster");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const pid = Number(host.read(pidFile).trim());
    process.kill(pid, "SIGTERM");
    execFileSync("pkill", ["-TERM", "-P", String(pid), "sleep"]);
    const result = await run;
    assert.equal(result.status, 143, result.output);
    assert.match(result.output, /stopped while starting k3s/);
    assert.deepEqual(readdirSync(host.temp), []);
  });
});

describe("review fixes", () => {
  test("stops when a root write fails, instead of treating it as unchanged", async () => {
    // A sudo that refuses to install files, as a full or read-only disk would.
    writeFileSync(
      join(host.bin, "sudo"),
      `#!/bin/bash\nif [ "$1" = -v ]; then exit 0; fi\nshift\nif [ "$1" = install ]; then exit 1; fi\nexec "$@"\n`,
      { mode: 0o755 },
    );
    const result = await install();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Could not (create|write) /);
    assert.ok(!existsSync(join(host.root, "usr/local/bin/k3s")));
  });

  test("reruns k3s's script after it stopped before the service", async () => {
    await installOnce();
    execFileSync("rm", [join(host.root, "etc/systemd/system/k3s.service")]);
    const result = await install();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /fake k3s install/);
  });

  test("keeps the caller's K3S settings from k3s's script", async () => {
    const result = await install({
      env: { K3S_URL: "https://elsewhere:6443", INSTALL_K3S_EXEC: "agent" },
    });
    assert.equal(result.status, 0, result.output);
    const k3s = host
      .rootCommands()
      .find((command) => command.includes("INSTALL_K3S_SYMLINK=skip"));
    assert.ok(k3s);
    assert.ok(k3s.includes("-u") && k3s.includes("K3S_URL"));
    assert.ok(k3s.includes("INSTALL_K3S_EXEC"));
  });

  test("refuses an unfinished hosts block", async () => {
    writeFileSync(
      join(host.root, "etc/hosts"),
      "127.0.0.1 localhost\n# BEGIN Everything local installer (install-k3s.sh)\n10.0.0.1 keep.me\n",
    );
    const result = await install();
    assert.equal(result.status, 1);
    assert.match(result.output, /Everything block without its END line/);
  });

  test("checks the installer before changing anything as root", async () => {
    host.removeCommand("certutil");
    host.prepareScript(undefined, {
      release_version: '"1.2.3"',
      installer_sha256: '"' + "0".repeat(64) + '"',
    });
    const result = await host.run({ answers: ["y"] });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Could not download|it was not used/);
    assert.deepEqual(host.rootCommands(), []);
  });

  for (const path of ["etc/kubernetes/admin.conf", "var/lib/k0s"]) {
    test(`refuses kubeadm and k0s: /${path}`, async () => {
      mkdirSync(join(host.root, path, ".."), { recursive: true });
      writeFileSync(join(host.root, path), "");
      const result = await install();
      assert.equal(result.status, 1);
      assert.match(result.output, /did not make/);
    });
  }
});

describe("reruns", () => {
  test("reuse k3s, the authority, the certificate, and the hosts entry", async () => {
    await installOnce();
    const ca = host.read(join(host.stateDirectory, "ca/ca.pem"));
    const leaf = host.read(join(host.stateDirectory, "tls/tls.crt"));
    const hosts = host.read(join(host.root, "etc/hosts"));
    const result = await install();
    assert.equal(result.status, 0, result.output);
    assert.equal(host.read(join(host.stateDirectory, "ca/ca.pem")), ca);
    assert.equal(host.read(join(host.stateDirectory, "tls/tls.crt")), leaf);
    assert.equal(host.read(join(host.root, "etc/hosts")), hosts);
    assert.ok(
      !host
        .calls()
        .some(
          (call) =>
            call.name === "curl" &&
            call.args.some((arg) => arg.includes("k3s")),
        ),
    );
    assert.ok(
      !host
        .calls()
        .some(
          (call) => call.name === "systemctl" && call.args[0] === "restart",
        ),
    );
    // The system store is refreshed on every run, so a refresh an earlier run lost is repeated.
    assert.ok(
      host.calls().some((call) => call.name === "update-ca-certificates"),
    );
    const backups = readdirSync(join(host.root, "etc")).filter((name) =>
      name.startsWith("hosts.everything-local-"),
    );
    assert.equal(backups.length, 1);
  });

  test("restart k3s when its settings change, and start it when stopped", async () => {
    await installOnce();
    writeFileSync(
      join(host.root, "etc/rancher/k3s/registries.yaml"),
      `${ownedMarker}\nconfigs: {}\n`,
    );
    let result = await install();
    assert.equal(result.status, 0, result.output);
    assert.ok(
      host
        .rootCommands()
        .some((command) => command.join(" ") === "systemctl restart k3s"),
    );
    writeFileSync(host.log, "");
    result = await install({ env: { FAKE_K3S_ACTIVE: "3" } });
    assert.equal(result.status, 0, result.output);
    assert.ok(
      host
        .rootCommands()
        .some((command) => command.join(" ") === "systemctl start k3s"),
    );
  });

  test("reissue a certificate the authority did not sign", async () => {
    await installOnce();
    const tls = join(host.stateDirectory, "tls");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-subj",
        "/CN=everything.internal",
        "-days",
        "30",
        "-keyout",
        join(tls, "tls.key"),
        "-out",
        join(tls, "tls.crt"),
      ],
      { stdio: "ignore" },
    );
    const result = await install();
    assert.equal(result.status, 0, result.output);
    execFileSync("openssl", [
      "verify",
      "-CAfile",
      join(host.stateDirectory, "ca/ca.pem"),
      join(tls, "tls.crt"),
    ]);
  });

  test("continue after a run that stopped before k3s was installed", async () => {
    host.prepareScript(undefined, { k3s_install_sha256: "0".repeat(64) });
    assert.equal((await install()).status, 1);
    host.prepareScript();
    const result = await install();
    assert.equal(result.status, 0, result.output);
    assert.ok(existsSync(join(host.root, "usr/local/bin/k3s")));
  });
});

describe("--remove-trust", () => {
  test("removes only this installer's authority and hosts entry", async () => {
    await installOnce();
    const anchors = join(host.root, "usr/local/share/ca-certificates");
    writeFileSync(join(anchors, "mkcert-rootCA.crt"), "unrelated\n");
    writeFileSync(
      join(anchors, "mkcert_development_CA_123.crt"),
      "unrelated\n",
    );
    const database = join(host.home, ".pki/nssdb");
    writeFileSync(
      join(database, "nicknames"),
      `${host.read(join(database, "nicknames"))}mkcert development CA 123\n`,
    );
    const result = await host.run({ args: ["--remove-trust"] });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(readdirSync(anchors).sort(), [
      "mkcert-rootCA.crt",
      "mkcert_development_CA_123.crt",
    ]);
    assert.equal(
      host.read(join(database, "nicknames")),
      "mkcert development CA 123\n",
    );
    assert.equal(
      host.read(join(host.root, "etc/hosts")),
      "127.0.0.1\tlocalhost\n::1\tlocalhost\n",
    );
    // The cluster and the authority's files stay.
    assert.ok(existsSync(join(host.root, "usr/local/bin/k3s")));
    assert.ok(existsSync(join(host.stateDirectory, "ca/ca-key.pem")));
  });

  test("runs as root without sudo", async () => {
    const result = await host.run({
      args: ["--remove-trust"],
      env: { FAKE_UID: "0" },
    });
    assert.equal(result.status, 0, result.output);
    assert.equal(host.calls().filter((call) => call.name === "sudo").length, 0);
  });
});

/** The first line of a PEM key's base64 body, which no other key shares. */
function keyBody(pem: string): string {
  const line = pem
    .split("\n")
    .find((text) => text && !text.startsWith("-----"));
  assert.ok(line && line.length > 40);
  return line;
}
