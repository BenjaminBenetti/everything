import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import ssh2 from "ssh2";
import { createKey, execute } from "./ssh-key-fixtures.js";

/** Git's environment: no system or user configuration, prompts, or agent from this process. */
function gitEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** A loopback SSH server for disposable bare repositories. */
export interface GitServer {
  readonly port: number;
  /** A known_hosts file naming the server's host key, for strict host-key checking. */
  readonly knownHosts: string;
  close(): Promise<void>;
}

/** Create a bare repository `name` in `directory` with one commit whose README says `content`. */
export async function createRepository(
  directory: string,
  name: string,
  content: string,
): Promise<void> {
  const work = path.join(directory, `${name}-work`);
  const environment = {
    ...gitEnvironment(directory),
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  await mkdir(work, { recursive: true });
  await execute("git", ["init", "-q", "-b", "main", work], {
    env: environment,
  });
  await writeFile(path.join(work, "README"), content);
  await execute("git", ["-C", work, "add", "README"], { env: environment });
  await execute("git", ["-C", work, "commit", "-q", "-m", "Fixture"], {
    env: environment,
  });
  await execute(
    "git",
    ["clone", "-q", "--bare", work, path.join(directory, `${name}.git`)],
    { env: environment },
  );
}

/**
 * Serve `repositories` read-only over SSH on loopback to clients that authenticate with one of
 * `authorized` public keys, running `git upload-pack` for each clone.
 */
export async function startGitServer(
  root: string,
  repositories: string,
  authorized: readonly string[],
): Promise<GitServer> {
  const directory = await mkdtemp(path.join(root, "server-"));
  const hostKey = await createKey(directory, "host-key");
  const allowed = authorized.map((line) => {
    const key = ssh2.utils.parseKey(line);
    if (key instanceof Error) throw key;
    return key;
  });
  const server = new ssh2.Server({ hostKeys: [hostKey.material] }, (client) => {
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.method !== "publickey") return context.reject(["publickey"]);
      const key = allowed.find(
        (candidate) =>
          candidate.type === context.key.algo &&
          candidate.getPublicSSH().length === context.key.data.length &&
          timingSafeEqual(candidate.getPublicSSH(), context.key.data),
      );
      if (
        !key ||
        (context.signature &&
          key.verify(context.blob!, context.signature, context.hashAlgo) !==
            true)
      )
        return context.reject(["publickey"]);
      context.accept();
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        acceptSession().on("exec", (accept, reject, info) => {
          const match = /^git-upload-pack '\/?([A-Za-z0-9-]+\.git)'$/.exec(
            info.command,
          );
          if (!match) return reject();
          const stream = accept();
          const child = spawn(
            "git",
            ["upload-pack", path.join(repositories, match[1]!)],
            { env: gitEnvironment(root) },
          );
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr);
          child.on("close", (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const knownHosts = path.join(directory, "known_hosts");
  const [type, key] = hostKey.publicKey.split(" ");
  await writeFile(knownHosts, `[127.0.0.1]:${port} ${type} ${key}\n`);
  return {
    port,
    knownHosts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** How one clone reaches an agent and checks the server's host key. */
export interface CloneOptions {
  /** The process's `SSH_AUTH_SOCK`, as a teammate pod or fleetd's redirected children set it. */
  readonly agent?: string;
  /** An `IdentityAgent` setting, as Everything's image adds to its SSH client configuration. */
  readonly identityAgent?: string;
  readonly knownHosts: string;
}

/**
 * Clone `repository` from `server` with OpenSSH and the exact options Fleet's managed clone adds,
 * returning README on success. The client reads only the configuration written here: its own
 * known_hosts, no identity files, and none of this account's SSH settings or agent.
 */
export async function cloneRepository(
  root: string,
  server: GitServer,
  repository: string,
  options: CloneOptions,
): Promise<{
  readonly ok: boolean;
  readonly readme?: string;
  readonly output: string;
}> {
  const attempt = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const config = path.join(root, `ssh-config-${attempt}`);
  await writeFile(
    config,
    [
      "Host *",
      `    UserKnownHostsFile ${options.knownHosts}`,
      "    GlobalKnownHostsFile /dev/null",
      "    IdentityFile /dev/null",
      ...(options.identityAgent
        ? [`    IdentityAgent ${options.identityAgent}`]
        : []),
      "",
    ].join("\n"),
  );
  const destination = path.join(root, `clone-${attempt}`);
  try {
    await execute(
      "git",
      [
        "clone",
        "-q",
        `ssh://git@127.0.0.1:${server.port}/${repository}`,
        destination,
      ],
      {
        env: {
          ...gitEnvironment(root),
          ...(options.agent ? { SSH_AUTH_SOCK: options.agent } : {}),
          GIT_SSH_COMMAND: `ssh -F ${config} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o CheckHostIP=no -o ConnectTimeout=15`,
        },
        timeout: 30_000,
      },
    );
    return {
      ok: true,
      readme: await readFile(path.join(destination, "README"), "utf8"),
      output: "",
    };
  } catch (error) {
    return { ok: false, output: String((error as { stderr?: string }).stderr) };
  }
}
