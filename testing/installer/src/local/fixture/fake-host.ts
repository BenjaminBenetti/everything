import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's deployment scripts. */
export const scriptDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../deployment/script",
);

/** Real tools the installers use, linked into a folder so tests choose every other command. */
const realTools = [
  "awk",
  "base64",
  "bash",
  "cat",
  "chmod",
  "cmp",
  "cp",
  "cut",
  "date",
  "df",
  "dirname",
  "env",
  "grep",
  "gzip",
  "head",
  "install",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "openssl",
  "rm",
  "sed",
  "sh",
  "sha256sum",
  "sleep",
  "sort",
  "stat",
  "sync",
  "tail",
  "tar",
  "tee",
  "test",
  "timeout",
  "touch",
  "tr",
  "wc",
];

/** A finished run of an installer: its exit status and everything it wrote to the terminal. */
export interface RunResult {
  readonly status: number;
  readonly output: string;
}

/** One logged command: its name and arguments, and the KUBECONFIG it ran with. */
export interface CommandCall {
  readonly name: string;
  readonly args: readonly string[];
  readonly kubeconfig: string;
}

/** How a run of install-k3s.sh is set up. */
export interface RunOptions {
  /** Lines typed at the terminal, in order. */
  readonly answers?: readonly string[];
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Feed the script to Bash on standard input, as `curl ... | bash` does. */
  readonly piped?: boolean;
  /** Run without a terminal. */
  readonly noTerminal?: boolean;
  /** Run this copy of the script instead of the host's prepared one. */
  readonly script?: string;
}

const mocks: Record<string, string> = {
  // Every mock logs its name, its arguments, separated by the unit separator, and KUBECONFIG.
  _log: `log_call() {
  local name=$1 IFS=$'\\037'
  shift
  printf '%s\\t%s\\t%s\\n' "$name" "$*" "\${KUBECONFIG:-}" >> "$FAKE_LOG"
}`,
  uname: `case \${1:-} in
  -s) echo "\${FAKE_UNAME_S:-Linux}" ;;
  -m) echo "\${FAKE_UNAME_M:-x86_64}" ;;
  -n) echo testhost ;;
  *) echo Linux ;;
esac`,
  id: `case \${1:-} in
  -u) echo "\${FAKE_UID:-$(/usr/bin/id -u)}" ;;
  -un) echo tester ;;
  *) /usr/bin/id "$@" ;;
esac`,
  // FAKE_SUDO_FAIL is a pattern for root commands that fail, after sending FAKE_SUDO_SIGNAL, if
  // set, to the installer, as if it were interrupted there. Before root commands matching
  // FAKE_SUDO_HOOK, it runs FAKE_SUDO_HOOK_RUN, as another program would meanwhile.
  sudo: `log_call sudo "$@"
if [ "\${1:-}" = -v ]; then exit "\${FAKE_SUDO_STATUS:-0}"; fi
if [ "\${1:-}" = -n ]; then shift; fi
if [ "\${1:-}" = -- ]; then shift; fi
if [ -n "\${FAKE_SUDO_HOOK:-}" ] && [[ "$*" == $FAKE_SUDO_HOOK ]]; then eval "$FAKE_SUDO_HOOK_RUN"; fi
if [ -n "\${FAKE_SUDO_FAIL:-}" ] && [[ "$*" == $FAKE_SUDO_FAIL ]]; then
  echo "fake sudo: $1 failed" >&2
  if [ -n "\${FAKE_SUDO_SIGNAL:-}" ]; then kill -"$FAKE_SUDO_SIGNAL" "$PPID"; fi
  exit 1
fi
exec "$@"`,
  systemctl: `log_call systemctl "$@"
case "$*" in
  "is-active --quiet k3s") exit "\${FAKE_K3S_ACTIVE:-0}" ;;
esac`,
  ss: `for port in \${FAKE_PORTS_IN_USE:-}; do
  case "$*" in *"sport = :$port"*) echo "LISTEN 0 4096 0.0.0.0:$port 0.0.0.0:*" ;; esac
done`,
  curl: `log_call curl "$@"
output="" url="" write_out=""
while [ $# -gt 0 ]; do
  case $1 in
    --output) output=$2; shift 2 ;;
    --write-out) write_out=$2; shift 2 ;;
    --proto | --retry | --connect-timeout | --max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case $url in
  https://everything.internal/* | https://artifacts.everything.internal/* | https://images.everything.internal/*)
    code=$(awk -F '\\t' -v url="$url" '$1 == url { print $2 }' "$FAKE_ENDPOINTS")
    [ -n "$code" ] || exit 60
    if [ -n "$write_out" ]; then printf '%s' "$code"; fi
    exit 0
    ;;
esac
source_file=$(awk -F '\\t' -v url="$url" '$1 == url { print $2 }' "$FAKE_DOWNLOADS")
if [ -z "$source_file" ]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
cat "$source_file" > "$output"`,
  kubectl: `log_call kubectl "$@"
args=" $* "
case $args in
  *" get --raw=/readyz "*)
    if [ -n "\${FAKE_HANG_READYZ:-}" ]; then echo "$PPID" > "$FAKE_HANG_READYZ"; exec sleep 30; fi
    exit "\${FAKE_READYZ_STATUS:-0}"
    ;;
  *" get deployment traefik "*) printf '%s' "\${FAKE_TRAEFIK_HOST_IP-127.0.0.1}" ;;
  *" get deployments,statefulsets "*) echo statefulset.apps/everything ;;
  *" create secret "*)
    # A dry run prints the Secret; this one lists the files it read, with their contents.
    echo "kind: Secret"
    previous=""
    for argument in "$@"; do
      case $previous in
        --cert | --key) printf '%s: |\\n' "$previous"; sed 's/^/  /' "$argument" ;;
        --from-file) printf '%s: |\\n' "\${argument%%=*}"; sed 's/^/  /' "\${argument#*=}" ;;
      esac
      previous=$argument
    done
    ;;
  *" apply -f - "*) { echo "# applied"; cat; } >> "$FAKE_APPLIED" ;;
esac`,
  helm: `log_call helm "$@"
case "$*" in
  "version --template {{.Version}}") [ -n "\${FAKE_HELM_VERSION:-v3.14.0}" ] && echo "\${FAKE_HELM_VERSION:-v3.14.0}" || exit 1 ;;
  status*)
    if [ "\${FAKE_HELM_STATUS:-0}" != 0 ]; then echo "Error: Kubernetes cluster unreachable: connection refused" >&2; fi
    exit "\${FAKE_HELM_STATUS:-0}"
    ;;
esac`,
  // FAKE_CERTUTIL_FAIL_DELETE names a nickname certutil cannot delete, as when a browser holds
  // its database.
  certutil: `log_call certutil "$@"
database="" nickname="" action=""
while [ $# -gt 0 ]; do
  case $1 in
    -d) database=\${2#sql:}; shift 2 ;;
    -n) nickname=$2; shift 2 ;;
    -N | -A | -L | -D) action=$1; shift ;;
    -t | -i) shift 2 ;;
    *) shift ;;
  esac
done
list=$database/nicknames
case $action in
  -N) touch "$database/cert9.db" "$list" ;;
  -A) echo "$nickname" >> "$list" ;;
  -D)
    if [ "$nickname" = "\${FAKE_CERTUTIL_FAIL_DELETE:-}" ]; then echo "certutil: database is locked" >&2; exit 255; fi
    grep -vxF "$nickname" "$list" > "$list.next" || true; mv "$list.next" "$list"
    ;;
  -L)
    if [ -n "$nickname" ]; then grep -qxF "$nickname" "$list" 2> /dev/null; exit; fi
    printf 'Certificate Nickname                                         Trust Attributes\\n\\n'
    if [ -f "$list" ]; then
      while IFS= read -r name; do printf '%-60s C,,   \\n' "$name"; done < "$list"
    fi
    ;;
esac`,
  // The store tools compile their anchors into the bundle TLS clients read. FAKE_TRUST_FAIL makes
  // them fail, and FAKE_TRUST_STALE succeed without compiling, leaving the bundle as it was.
  "update-ca-certificates": `log_call update-ca-certificates "$@"
if [ -n "\${FAKE_TRUST_FAIL:-}" ]; then echo "update-ca-certificates: failed" >&2; exit 1; fi
if [ -n "\${FAKE_TRUST_STALE:-}" ]; then exit 0; fi
mkdir -p "$FAKE_ROOT/etc/ssl/certs"
cat "$FAKE_ROOT"/usr/local/share/ca-certificates/*.crt > "$FAKE_ROOT/etc/ssl/certs/ca-certificates.crt" 2> /dev/null || true`,
  "update-ca-trust": `log_call update-ca-trust "$@"
if [ -n "\${FAKE_TRUST_FAIL:-}" ]; then echo "update-ca-trust: failed" >&2; exit 1; fi
if [ -n "\${FAKE_TRUST_STALE:-}" ]; then exit 0; fi
mkdir -p "$FAKE_ROOT/etc/pki/ca-trust/extracted/pem"
cat "$FAKE_ROOT"/etc/pki/ca-trust/source/anchors/*.pem > "$FAKE_ROOT/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem" 2> /dev/null || true`,
  "apt-get": `log_call apt-get "$@"
for package in "$@"; do
  case $package in libnss3-tools) cp "$FAKE_BIN/certutil.off" "$FAKE_BIN/certutil" ;; esac
done`,
  ip: `echo "1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5"`,
};

/**
 * A scratch Linux host for the installers: a system root with its own /etc, /proc, and /var, a
 * home folder, mock commands that log every call, and a terminal driven through `script`.
 */
export class FakeHost {
  readonly directory: string;
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  readonly temp: string;
  readonly log: string;
  readonly applied: string;
  readonly downloads: string;
  readonly endpoints: string;
  readonly installerLog: string;
  readonly script: string;
  readonly fakeInstaller: string;
  readonly k3sInstallScript: string;

  constructor() {
    this.directory = mkdtempSync(join(tmpdir(), "everything-installer-test-"));
    this.root = join(this.directory, "root");
    this.home = join(this.directory, "home");
    this.bin = join(this.directory, "bin");
    this.temp = join(this.directory, "tmp");
    this.log = join(this.directory, "calls.log");
    this.applied = join(this.directory, "applied.yaml");
    this.downloads = join(this.directory, "downloads.tsv");
    this.endpoints = join(this.directory, "endpoints.tsv");
    this.installerLog = join(this.directory, "installer.env");
    this.script = join(this.directory, "install-k3s.sh");
    this.fakeInstaller = join(this.directory, "fake-install.sh");
    this.k3sInstallScript = join(this.directory, "k3s-install.sh");
    for (const folder of [
      this.home,
      this.bin,
      this.temp,
      join(this.directory, "real"),
      join(this.root, "etc"),
      join(this.root, "proc/sys/kernel"),
      join(this.root, "run/systemd/system"),
      join(this.root, "var/lib"),
      join(this.root, "usr/local/share/ca-certificates"),
    ]) {
      mkdirSync(folder, { recursive: true });
    }
    writeFileSync(
      join(this.root, "etc/hosts"),
      "127.0.0.1\tlocalhost\n::1\tlocalhost\n",
    );
    writeFileSync(
      join(this.root, "proc/meminfo"),
      "MemTotal:       16000000 kB\n",
    );
    writeFileSync(
      join(this.root, "proc/sys/kernel/osrelease"),
      "6.8.0-generic\n",
    );
    for (const file of [this.log, this.applied, this.installerLog]) {
      writeFileSync(file, "");
    }
    this.writeMocks();
    this.writeFakeInstaller();
    this.writeK3sInstallScript();
    this.setEndpoints({
      "https://everything.internal/health/ready": "200",
      "https://artifacts.everything.internal/": "404",
      "https://images.everything.internal/v2/": "401",
    });
    this.prepareScript();
  }

  /** The installer's private folder in the fake home. */
  get stateDirectory(): string {
    return join(this.home, ".local/share/everything-local");
  }

  /** Write install-k3s.sh pointed at this host's system root, trusting its fake k3s script. */
  prepareScript(
    source = readFileSync(join(scriptDirectory, "install-k3s.sh"), "utf8"),
    replacements: Readonly<Record<string, string>> = {},
  ): void {
    const settings: Record<string, string> = {
      system_root: `"${this.root}"`,
      k3s_install_sha256: sha256(readFileSync(this.k3sInstallScript)),
      cluster_timeout: "20",
      everything_timeout: "20",
      ...replacements,
    };
    let script = source;
    for (const [name, value] of Object.entries(settings)) {
      const line = new RegExp(`^${name}=.*$`, "m");
      if (!line.test(script)) throw new Error(`install-k3s.sh lacks ${name}=`);
      script = script.replace(line, `${name}=${value}`);
    }
    writeFileSync(this.script, script, { mode: 0o755 });
    this.setDownloads({});
  }

  /** Serve these URLs from these files; the k3s install script is always served. */
  setDownloads(files: Readonly<Record<string, string>>): void {
    const k3sUrl = readFileSync(this.script, "utf8").match(
      /^k3s_install_url=(.*)$/m,
    )?.[1];
    const entries = { ...files };
    if (k3sUrl && !(k3sUrl in entries)) entries[k3sUrl] = this.k3sInstallScript;
    writeFileSync(
      this.downloads,
      Object.entries(entries)
        .map(([url, file]) => `${url}\t${file}\n`)
        .join(""),
    );
  }

  /** Answer the local URLs with these HTTP codes; others fail certificate verification. */
  setEndpoints(codes: Readonly<Record<string, string>>): void {
    writeFileSync(
      this.endpoints,
      Object.entries(codes)
        .map(([url, code]) => `${url}\t${code}\n`)
        .join(""),
    );
  }

  /** Remove a mock, so the host lacks that command. */
  removeCommand(name: string): void {
    rmSync(join(this.bin, name), { force: true });
  }

  /** Run install-k3s.sh, or another script, in a terminal. */
  run(options: RunOptions = {}): Promise<RunResult> {
    const script = options.script ?? this.script;
    const args = (options.args ?? []).map(shellQuote).join(" ");
    const command = options.piped
      ? `bash -s -- ${args} < ${shellQuote(script)}`
      : `bash ${shellQuote(script)} ${args}`;
    const env = this.environment(options.env ?? {});
    const answers = (options.answers ?? []).map((answer) => `${answer}\n`);
    if (options.noTerminal) {
      return execute(
        requireTool("setsid"),
        ["--wait", requireTool("bash"), "-c", command],
        env,
        answers.join(""),
      );
    }
    return execute(
      requireTool("script"),
      ["--quiet", "--return", "--flush", "--command", command, "/dev/null"],
      env,
      answers,
    );
  }

  /** The environment the installers run with: only the host's commands and fake state. */
  environment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    return {
      PATH: [this.bin, join(this.directory, "real")].join(delimiter),
      HOME: this.home,
      TMPDIR: this.temp,
      SHELL: "/bin/bash",
      TERM: "dumb",
      LANG: "C",
      FAKE_BIN: this.bin,
      FAKE_ROOT: this.root,
      FAKE_LOG: this.log,
      FAKE_APPLIED: this.applied,
      FAKE_DOWNLOADS: this.downloads,
      FAKE_ENDPOINTS: this.endpoints,
      FAKE_INSTALLER_LOG: this.installerLog,
      ...extra,
    };
  }

  /** Every logged command, in order. */
  calls(): CommandCall[] {
    return readFileSync(this.log, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name = "", args = "", kubeconfig = ""] = line.split("\t");
        return {
          name,
          args: args.length > 0 ? args.split("\u001f") : [],
          kubeconfig,
        };
      });
  }

  /** The commands run through sudo, as their own argument lists. */
  rootCommands(): string[][] {
    return this.calls()
      .filter((call) => call.name === "sudo" && call.args[0] === "--")
      .map((call) => call.args.slice(1));
  }

  /** Every file under a folder, recursively, as paths relative to it. */
  files(folder = this.root): string[] {
    if (!existsSync(folder)) return [];
    return readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  }

  read(path: string): string {
    return readFileSync(path, "utf8");
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }

  private writeMocks(): void {
    for (const [name, body] of Object.entries(mocks)) {
      if (name === "_log") continue;
      writeFileSync(
        join(this.bin, name),
        `#!/bin/bash\n${mocks._log}\n${body}\n`,
        { mode: 0o755 },
      );
    }
    // apt-get installs certutil from this copy when a test removes it.
    writeFileSync(
      join(this.bin, "certutil.off"),
      readFileSync(join(this.bin, "certutil")),
      {
        mode: 0o755,
      },
    );
    for (const tool of realTools) {
      const found = findTool(tool);
      if (found) symlinkSync(found, join(this.directory, "real", tool));
    }
  }

  private writeFakeInstaller(): void {
    writeFileSync(
      this.fakeInstaller,
      `#!/bin/bash
env | grep -E '^(KUBECONFIG|EVERYTHING_[A-Z_]+|PATH)=' | sort > "$FAKE_INSTALLER_LOG"
if [ -n "\${EVERYTHING_PRESET_SETTINGS:-}" ]; then cp "$EVERYTHING_PRESET_SETTINGS" "$FAKE_INSTALLER_LOG.preset"; fi
read -r answer < /dev/tty
echo "installer read: $answer" >&2
if [ -n "\${FAKE_INSTALLER_DECLINE:-}" ]; then echo declined > "$EVERYTHING_RESULT_FILE"; fi
exit "\${FAKE_INSTALLER_STATUS:-0}"
`,
      { mode: 0o755 },
    );
  }

  /** A k3s install script that lays down k3s's files in the system root, as the real one does. */
  private writeK3sInstallScript(): void {
    const root = this.root;
    writeFileSync(
      this.k3sInstallScript,
      `#!/bin/sh
set -e
echo "fake k3s install: $INSTALL_K3S_VERSION symlink=$INSTALL_K3S_SYMLINK $*" >&2
mkdir -p "${root}/usr/local/bin" "${root}/etc/systemd/system" "${root}/etc/rancher/k3s"
printf '#!/bin/sh\\nexit 0\\n' > "${root}/usr/local/bin/k3s"
chmod 755 "${root}/usr/local/bin/k3s"
printf '#!/bin/sh\\nexit 0\\n' > "${root}/usr/local/bin/k3s-uninstall.sh"
chmod 755 "${root}/usr/local/bin/k3s-uninstall.sh"
touch "${root}/etc/systemd/system/k3s.service"
cat > "${root}/etc/rancher/k3s/k3s.yaml" << 'EOF'
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: Y2x1c3Rlcg==
    server: https://127.0.0.1:6443
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
kind: Config
users:
- name: default
  user:
    client-key-data: Y2xpZW50LWtleQ==
EOF
chmod 600 "${root}/etc/rancher/k3s/k3s.yaml"
`,
    );
  }
}

/** Run a command, typing each answer once the previous output has settled. */
function execute(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input: string | readonly string[],
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    // Its own process group, so a run that hangs on an unexpected question ends with everything
    // it started.
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const timer = setTimeout(() => {
      output += "\n[the run took over 60 seconds and was stopped]\n";
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    }, 60_000);
    let output = "";
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.stdin.on("error", () => undefined);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        status: code ?? (signal ? 128 : 1),
        output: output.replace(/\r/g, ""),
      });
    });
    if (typeof input === "string") {
      child.stdin.end(input);
      return;
    }
    // The terminal keeps typed lines until a prompt reads them, so all of them go at once; the
    // input stays open until the run ends, as a person's keyboard does.
    child.stdin.write(input.join(""));
  });
}

function requireTool(name: string): string {
  const found = findTool(name);
  if (!found) throw new Error(`The tests need ${name}.`);
  return found;
}

function findTool(name: string): string | undefined {
  for (const folder of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    const path = join(folder, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Make a file executable, for tests that write their own commands. */
export function executable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
