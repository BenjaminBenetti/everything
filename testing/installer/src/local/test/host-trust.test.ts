import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { FakeHost } from "../fixture/fake-host.js";

let host: FakeHost;

beforeEach(() => {
  host = new FakeHost();
});

afterEach(() => {
  host.dispose();
});

const begin = "# BEGIN Everything local installer (install-k3s.sh)";
const end = "# END Everything local installer";
const mapping =
  "127.0.0.1\teverything.internal artifacts.everything.internal images.everything.internal";
const trusted = /no longer trusted on this computer/;

/** Run the source copy with the fake installer, agreeing to the plan. */
function install(env: Record<string, string> = {}) {
  return host.run({
    args: ["--installer", host.fakeInstaller],
    answers: ["y", "installer answer"],
    env,
  });
}

function removeTrust(env: Record<string, string> = {}) {
  return host.run({ args: ["--remove-trust"], env });
}

/** Lay down a finished installation, then forget the commands it ran. */
async function installOnce(): Promise<void> {
  const result = await install();
  assert.equal(result.status, 0, result.output);
  writeFileSync(host.log, "");
}

function hostsPath(): string {
  return join(host.root, "etc/hosts");
}

function anchors(): string[] {
  return readdirSync(join(host.root, "usr/local/share/ca-certificates"));
}

function bundle(): string {
  const path = join(host.root, "etc/ssl/certs/ca-certificates.crt");
  return existsSync(path) ? host.read(path) : "";
}

/** A PEM certificate's base64 body, unwrapped, as the installer compares them. */
function pemBody(pem: string): string {
  const match =
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  assert.ok(match, "no certificate");
  return (match[1] ?? "").replace(/\s/g, "");
}

function bundleTrustsAuthority(): boolean {
  const body = pemBody(host.read(join(host.stateDirectory, "ca/ca.pem")));
  return bundle().replace(/\s/g, "").includes(body);
}

function storeUpdates(): number {
  return host.calls().filter((call) => call.name === "update-ca-certificates")
    .length;
}

function nicknames(): string {
  return host.read(join(host.home, ".pki/nssdb/nicknames"));
}

/** Files the installer staged beside system files and did not rename into place. */
function leftovers(): string[] {
  return host
    .files(host.root)
    .filter((file) =>
      /\/\.[^/]+\.everything-local\.[A-Za-z0-9]{6}$/.test(file),
    );
}

function backups(): string[] {
  return readdirSync(join(host.root, "etc"))
    .filter((name) => name.startsWith("hosts.everything-local-"))
    .sort();
}

/** The hosts file's bytes, inode, and mode, which a refused or failed change keeps. */
function hostsSnapshot(): { content: string; inode: number; mode: number } {
  const stat = statSync(hostsPath());
  return {
    content: host.read(hostsPath()),
    inode: stat.ino,
    mode: stat.mode & 0o7777,
  };
}

describe("system trust store refresh", () => {
  test("a rerun refreshes the store after a refresh failed with the anchor already written", async () => {
    let result = await install({ FAKE_TRUST_FAIL: "1" });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /Could not update the system certificate store/,
    );
    assert.equal(anchors().length, 1);
    assert.equal(bundleTrustsAuthority(), false);

    writeFileSync(host.log, "");
    result = await install();
    assert.equal(result.status, 0, result.output);
    // The anchor was unchanged, and the store was refreshed anyway.
    assert.ok(storeUpdates() >= 1);
    assert.equal(bundleTrustsAuthority(), true);
  });

  test("refuses to continue when the store's bundle lacks the authority after a refresh", async () => {
    const result = await install({ FAKE_TRUST_STALE: "1" });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /does not include the local certificate authority after updating it/,
    );
    assert.doesNotMatch(result.output, /Everything is running/);
  });

  test("trusts and checks the authority in a dnf-style store", async () => {
    mkdirSync(join(host.root, "etc/pki/ca-trust/source/anchors"), {
      recursive: true,
    });
    const result = await install();
    assert.equal(result.status, 0, result.output);
    const pki = join(host.root, "etc/pki/ca-trust/source/anchors");
    assert.match(
      readdirSync(pki)[0] ?? "",
      /^everything-local-ca-[0-9a-f]{16}\.pem$/,
    );
    assert.ok(
      host
        .calls()
        .some(
          (call) =>
            call.name === "update-ca-trust" && call.args[0] === "extract",
        ),
    );
    const compiled = host.read(
      join(host.root, "etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"),
    );
    assert.ok(
      compiled
        .replace(/\s/g, "")
        .includes(pemBody(host.read(join(host.stateDirectory, "ca/ca.pem")))),
    );
  });

  test("a removal whose refresh failed after deleting the anchor is finished by a rerun", async () => {
    await installOnce();
    assert.equal(bundleTrustsAuthority(), true);
    let result = await removeTrust({ FAKE_TRUST_FAIL: "1" });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /Could not update the system certificate store/,
    );
    assert.doesNotMatch(result.output, trusted);
    assert.deepEqual(anchors(), []);
    // The compiled bundle still trusts it, as a real store would.
    assert.equal(bundleTrustsAuthority(), true);

    writeFileSync(host.log, "");
    result = await removeTrust();
    assert.equal(result.status, 0, result.output);
    assert.ok(storeUpdates() >= 1);
    assert.equal(bundleTrustsAuthority(), false);
    assert.doesNotMatch(bundle(), /BEGIN CERTIFICATE/);
    assert.match(result.output, trusted);
  });

  test("does not report removal while the bundle still trusts the authority", async () => {
    await installOnce();
    const result = await removeTrust({ FAKE_TRUST_STALE: "1" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /still trusts a local certificate authority/);
    assert.doesNotMatch(result.output, trusted);
  });

  test("finds an earlier authority in the bundle after its own files are gone", async () => {
    await installOnce();
    // The authority's folder was deleted, and an earlier removal lost its refresh.
    rmSync(host.stateDirectory, { recursive: true });
    for (const anchor of anchors()) {
      rmSync(join(host.root, "usr/local/share/ca-certificates", anchor));
    }
    let result = await removeTrust({ FAKE_TRUST_STALE: "1" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /still trusts a local certificate authority/);
    result = await removeTrust();
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(bundle(), /BEGIN CERTIFICATE/);
  });

  test("a second removal succeeds without changing anything", async () => {
    await installOnce();
    assert.equal((await removeTrust()).status, 0);
    const hosts = hostsSnapshot();
    const copies = backups();
    const result = await removeTrust();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, trusted);
    assert.deepEqual(hostsSnapshot(), hosts);
    assert.deepEqual(backups(), copies);
  });
});

describe("browser trust removal", () => {
  const other = "Everything local CA 0123456789abcdef";

  /** An installation whose shared database holds two of the installer's authorities. */
  async function twoAuthorities(): Promise<string[]> {
    await installOnce();
    const database = join(host.home, ".pki/nssdb/nicknames");
    writeFileSync(
      database,
      `${host.read(database)}${other}\nmkcert development CA 123\n`,
    );
    const ours = nicknames()
      .split("\n")
      .filter((name) => name.startsWith("Everything local CA "))
      .sort();
    assert.equal(ours.length, 2);
    return ours;
  }

  for (const position of ["first", "last"] as const) {
    test(`fails when the ${position} of two deletions fails, then a rerun finishes`, async () => {
      const ours = await twoAuthorities();
      const failing = (position === "first" ? ours[0] : ours[1]) ?? "";
      let result = await removeTrust({ FAKE_CERTUTIL_FAIL_DELETE: failing });
      assert.equal(result.status, 1, result.output);
      assert.match(
        result.output,
        new RegExp(`could not remove ${failing} from `),
      );
      assert.doesNotMatch(result.output, trusted);
      assert.match(nicknames(), new RegExp(`^${failing}$`, "m"));

      result = await removeTrust();
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, trusted);
      assert.equal(nicknames(), "mkcert development CA 123\n");
    });
  }

  test("fails before changing anything when certutil is missing for existing browser databases", async () => {
    await installOnce();
    host.removeCommand("certutil");
    const before = {
      anchors: anchors(),
      nicknames: nicknames(),
      hosts: hostsSnapshot(),
    };
    const result = await removeTrust();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /certutil is needed/);
    assert.match(result.output, /Nothing changed/);
    assert.doesNotMatch(result.output, trusted);
    assert.deepEqual(
      { anchors: anchors(), nicknames: nicknames(), hosts: hostsSnapshot() },
      before,
    );
  });

  test("fails when a browser database cannot be read", async () => {
    await installOnce();
    const certutil = join(host.bin, "certutil");
    writeFileSync(
      certutil,
      `#!/bin/bash\nfor a in "$@"; do if [ "$a" = -L ]; then echo "database is locked" >&2; exit 255; fi; done\nexit 0\n`,
    );
    chmodSync(certutil, 0o755);
    const result = await removeTrust();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /certutil could not read/);
    assert.doesNotMatch(result.output, trusted);
  });
});

describe("hosts file block", () => {
  const malformed: ReadonlyArray<readonly [string, string, RegExp]> = [
    [
      "a BEGIN line without END",
      `127.0.0.1 localhost\n${begin}\n${mapping}\n10.0.0.1 keep.me\n`,
      /without its END line, from line 2/,
    ],
    [
      "an END line without BEGIN",
      `127.0.0.1 localhost\n${mapping}\n${end}\n10.0.0.1 keep.me\n`,
      /END line outside an Everything block on line 3/,
    ],
    [
      "END before BEGIN",
      `127.0.0.1 localhost\n${end}\n10.0.0.1 keep.me\n${begin}\n${mapping}\n`,
      /END line outside an Everything block on line 2/,
    ],
    [
      "nested blocks",
      `${begin}\n${begin}\n${mapping}\n${end}\n10.0.0.1 keep.me\n${end}\n`,
      /second BEGIN line inside the Everything block on line 2/,
    ],
    [
      "two blocks",
      `${begin}\n${mapping}\n${end}\n10.0.0.1 keep.me\n${begin}\n${mapping}\n${end}\n`,
      /second Everything block on line 5/,
    ],
    [
      "another entry inside the block",
      `${begin}\n${mapping}\n10.0.0.1 keep.me\n${end}\n`,
      /entry for keep\.me inside the Everything block on line 3/,
    ],
    [
      "an edited marker",
      `${begin}\n${mapping}\n# END Everything local installer (edited)\n10.0.0.1 keep.me\n`,
      /edited BEGIN or END line on line 3/,
    ],
  ];

  for (const [name, content, message] of malformed) {
    test(`an installation refuses ${name} and leaves the file alone`, async () => {
      writeFileSync(hostsPath(), content);
      const before = hostsSnapshot();
      const result = await install();
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, message);
      assert.match(result.output, /will not change it/);
      assert.deepEqual(hostsSnapshot(), before);
      assert.deepEqual(host.rootCommands(), []);
    });

    test(`a removal refuses ${name}, still removes the trust, and says what is left`, async () => {
      await installOnce();
      writeFileSync(hostsPath(), content);
      const before = hostsSnapshot();
      const copies = backups();
      const result = await removeTrust();
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, message);
      assert.match(result.output, trusted);
      assert.match(
        result.output,
        /\/etc\/hosts was not changed, and may still map the local names/,
      );
      assert.deepEqual(anchors(), []);
      assert.equal(bundleTrustsAuthority(), false);
      assert.doesNotMatch(nicknames(), /Everything local CA/);
      assert.deepEqual(hostsSnapshot(), before);
      assert.deepEqual(backups(), copies);
    });
  }

  test("a removal keeps every other line byte for byte", async () => {
    const content = `127.0.0.1\tlocalhost\n# my comment  \n\n${begin}\n${mapping}\n\n${end}\n10.0.0.1   keep.me # trailing\n\t\n`;
    writeFileSync(hostsPath(), content);
    const result = await removeTrust();
    assert.equal(result.status, 0, result.output);
    assert.equal(
      host.read(hostsPath()),
      "127.0.0.1\tlocalhost\n# my comment  \n\n10.0.0.1   keep.me # trailing\n\t\n",
    );
  });

  test("a removal does not need the checks an installation makes of other entries", async () => {
    // An installation refuses a local name mapped elsewhere; removing the trust does not.
    writeFileSync(
      hostsPath(),
      `127.0.0.1 localhost\n10.0.0.9 everything.internal\n${begin}\n${mapping}\n${end}\n`,
    );
    const result = await removeTrust();
    assert.equal(result.status, 0, result.output);
    assert.equal(
      host.read(hostsPath()),
      "127.0.0.1 localhost\n10.0.0.9 everything.internal\n",
    );
  });
});

describe("replacing the hosts file", () => {
  test("renames a complete new file into place with the old one's mode", async () => {
    chmodSync(hostsPath(), 0o640);
    const before = hostsSnapshot();
    const result = await install();
    assert.equal(result.status, 0, result.output);
    const after = hostsSnapshot();
    assert.notEqual(after.inode, before.inode);
    assert.equal(after.mode, 0o640);
    assert.equal(
      after.content,
      `${before.content}${begin}\n${mapping}\n${end}\n`,
    );
    assert.deepEqual(leftovers(), []);
    // The copy kept the old file's attributes, without SELinux here.
    const copy = host
      .rootCommands()
      .find((command) => command.includes("--attributes-only"));
    assert.ok(
      copy?.includes("--preserve=mode,ownership,xattr"),
      copy?.join(" "),
    );
  });

  test("keeps the old file's extended attributes", async (context) => {
    try {
      execFileSync(
        "setfattr",
        ["-n", "user.everything", "-v", "kept", hostsPath()],
        {
          stdio: "ignore",
        },
      );
    } catch {
      context.skip(
        "this file system or computer lacks user extended attributes",
      );
      return;
    }
    const result = await install();
    assert.equal(result.status, 0, result.output);
    assert.match(
      execFileSync("getfattr", ["-n", "user.everything", hostsPath()], {
        encoding: "utf8",
      }),
      /user\.everything="kept"/,
    );
  });

  const failures: ReadonlyArray<readonly [string, string, RegExp]> = [
    [
      "the backup",
      "cp -p -- */etc/hosts */etc/hosts.everything-local-*",
      /Could not back up/,
    ],
    [
      "the new file",
      "cp -- * */etc/.hosts.everything-local.*",
      /Could not write a new copy/,
    ],
    [
      "flushing the new file",
      "sync -- */etc/.hosts.everything-local.*",
      /Could not write a new copy/,
    ],
    [
      "copying its attributes",
      "cp --attributes-only *",
      /owner, mode, and security attributes; it was not changed/,
    ],
    [
      "the rename",
      "mv -fT -- */etc/.hosts.everything-local.* */etc/hosts",
      /Could not replace .*\/etc\/hosts, so it was not changed/,
    ],
  ];

  for (const [step, pattern, message] of failures) {
    test(`leaves the old file as it was when ${step} fails`, async () => {
      chmodSync(hostsPath(), 0o640);
      const before = hostsSnapshot();
      const result = await install({ FAKE_SUDO_FAIL: pattern });
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, message);
      assert.deepEqual(hostsSnapshot(), before);
      assert.deepEqual(leftovers(), []);
    });
  }

  test("keeps the SELinux context too, and stops when it cannot", async () => {
    mkdirSync(join(host.root, "sys/fs/selinux"), { recursive: true });
    writeFileSync(join(host.root, "sys/fs/selinux/enforce"), "1\n");
    const before = hostsSnapshot();
    const result = await install({
      FAKE_SUDO_FAIL:
        "cp --attributes-only --preserve=mode,ownership,xattr,context *",
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /security attributes; it was not changed/);
    assert.deepEqual(hostsSnapshot(), before);
    assert.deepEqual(leftovers(), []);
    assert.ok(
      !host
        .rootCommands()
        .some(
          (command) => command[0] === "mv" && command.at(-1) === hostsPath(),
        ),
    );
  });

  test("an interruption before the rename leaves the old file and no staged copy", async () => {
    const before = hostsSnapshot();
    const result = await install({
      FAKE_SUDO_FAIL: "mv -fT -- */etc/.hosts.everything-local.* */etc/hosts",
      FAKE_SUDO_SIGNAL: "TERM",
    });
    assert.equal(result.status, 143, result.output);
    assert.deepEqual(hostsSnapshot(), before);
    assert.deepEqual(leftovers(), []);
  });

  test("keeps each previous file in a new backup, never over an existing one", async () => {
    const original = host.read(hostsPath());
    const older = join(
      host.root,
      "etc/hosts.everything-local-20200101000000-000001",
    );
    writeFileSync(older, "an older backup\n");
    await installOnce();
    const withBlock = host.read(hostsPath());
    assert.equal((await removeTrust()).status, 0);
    const made = backups().filter((name) => !older.endsWith(name));
    assert.equal(made.length, 2);
    assert.equal(host.read(older), "an older backup\n");
    const contents = made
      .map((name) => host.read(join(host.root, "etc", name)))
      .sort();
    assert.deepEqual(contents, [original, withBlock].sort());
  });

  test("a failed rename of another system file leaves no partial file", async () => {
    const result = await install({
      FAKE_SUDO_FAIL: "mv -fT -- */.everything-local-ca-*",
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Could not replace .*everything-local-ca-/);
    assert.deepEqual(anchors(), []);
    assert.deepEqual(leftovers(), []);
  });
});

describe("folders of system files", () => {
  test("creates missing folders, and keeps an existing folder's mode and other files", async () => {
    await installOnce();
    const config = join(host.root, "etc/rancher/k3s/config.yaml.d");
    assert.equal(statSync(config).mode & 0o777, 0o755);
    const manifests = join(host.root, "var/lib/rancher/k3s/server/manifests");
    chmodSync(manifests, 0o700);
    const unrelated = join(manifests, "admin-credentials.yaml");
    writeFileSync(unrelated, "token: kept\n");
    chmodSync(unrelated, 0o644);
    writeFileSync(
      join(manifests, "everything-local-traefik.yaml"),
      "changed\n",
    );
    const result = await install();
    assert.equal(result.status, 0, result.output);
    assert.equal(statSync(manifests).mode & 0o777, 0o700);
    assert.equal(host.read(unrelated), "token: kept\n");
    assert.equal(statSync(unrelated).mode & 0o777, 0o644);
    assert.match(
      host.read(join(manifests, "everything-local-traefik.yaml")),
      /kind: HelmChartConfig/,
    );
    assert.ok(
      !host
        .rootCommands()
        .some(
          (command) => command[0] === "install" && command.at(-1) === manifests,
        ),
    );
  });
});

describe("review follow-ups", () => {
  test("stops when the hosts file changes while it is being replaced", async () => {
    const result = await install({
      FAKE_SUDO_HOOK: "cp --attributes-only *",
      FAKE_SUDO_HOOK_RUN:
        'echo "10.0.0.2 added.meanwhile" >> "$FAKE_ROOT/etc/hosts"',
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /changed while the installer ran/);
    const hosts = host.read(hostsPath());
    assert.match(hosts, /added\.meanwhile/);
    assert.doesNotMatch(hosts, /BEGIN Everything/);
    assert.deepEqual(leftovers(), []);
  });

  test("a removal leaves a symbolically linked hosts file without the block alone and succeeds", async () => {
    const target = join(host.directory, "hosts.real");
    writeFileSync(target, "127.0.0.1 localhost\n");
    rmSync(hostsPath());
    symlinkSync(target, hostsPath());
    const result = await removeTrust();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, trusted);
    assert.equal(host.read(target), "127.0.0.1 localhost\n");
  });

  test("a removal refuses a symbolically linked hosts file with the block", async () => {
    const target = join(host.directory, "hosts.real");
    const content = `127.0.0.1 localhost\n${begin}\n${mapping}\n${end}\n`;
    writeFileSync(target, content);
    rmSync(hostsPath());
    symlinkSync(target, hostsPath());
    const result = await removeTrust();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, trusted);
    assert.match(result.output, /was not changed.*symbolic link/);
    assert.equal(host.read(target), content);
  });

  test("a removal with nothing to remove leaves a file without its last newline as it is", async () => {
    writeFileSync(hostsPath(), "127.0.0.1 localhost");
    const before = hostsSnapshot();
    const result = await removeTrust();
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(hostsSnapshot(), before);
    assert.deepEqual(backups(), []);
    assert.doesNotMatch(result.output, /Updated \/etc\/hosts/);
  });

  test("an installation adds the block to a file without its last newline", async () => {
    writeFileSync(hostsPath(), "127.0.0.1 localhost");
    const result = await install();
    assert.equal(result.status, 0, result.output);
    assert.equal(
      host.read(hostsPath()),
      `127.0.0.1 localhost\n${begin}\n${mapping}\n${end}\n`,
    );
  });

  test("a removal deletes an anchor copy an interrupted run left in the dnf store", async () => {
    const pki = join(host.root, "etc/pki/ca-trust/source/anchors");
    mkdirSync(pki, { recursive: true });
    await installOnce();
    const [anchor] = readdirSync(pki);
    assert.ok(anchor);
    const leftover = join(pki, `.${anchor}.everything-local.Ab12Cd`);
    writeFileSync(leftover, host.read(join(pki, anchor)));
    const result = await removeTrust();
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(readdirSync(pki), []);
    assert.doesNotMatch(
      host.read(
        join(host.root, "etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"),
      ),
      /BEGIN CERTIFICATE/,
    );
  });
});
