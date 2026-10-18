import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  fleetClientWorkspaceMount,
  fleetGatewayFileName,
  fleetTokenWorkspaceFile,
  sharedWorkspacePath,
  workspacePath,
} from "@everything/workspace-contracts/mount";
import { accepts } from "../../fleet/adapter/listener-probe.js";
import { fleetEnvironment, fleetHome } from "../../fleet/model/fleet-home.js";
import { FleetClientPublisher } from "../../fleet/service/fleet-client-publisher.js";
import { FleetDaemon } from "../../fleet/service/fleet-daemon.js";
import { FleetRemoteSetup } from "../../fleet/service/fleet-remote-setup.js";
import { workspaceToken } from "../../workspace/model/workspace-access.js";

const run = promisify(execFile);

/**
 * What the real-process Fleet stack needs from the machine running it: the pinned Fleet release
 * binary, a Fleet home that already holds a worker instance, the teammate image built from this
 * repository, and the chart's gateway image. Without all of them the end-to-end tests are skipped.
 */
export interface FleetStackSettings {
  readonly binary: string;
  readonly home: string;
  readonly worker: string;
  readonly teammateImage: string;
  readonly gatewayImage: string;
  /** PATH for fleetd, which reaches the worker's container with Docker. */
  readonly path: string;
  /** Optionally, a Fleet client of another version, for the version-mismatch check. */
  readonly otherClient: string | undefined;
}

/** Read the stack's settings from FLEET_E2E_* variables, or undefined when they are not all set. */
export function fleetStackSettings(
  environment: NodeJS.ProcessEnv = process.env,
): FleetStackSettings | undefined {
  const {
    FLEET_E2E_BINARY: binary,
    FLEET_E2E_HOME: home,
    FLEET_E2E_WORKER: worker,
    FLEET_E2E_TEAMMATE_IMAGE: teammateImage,
    FLEET_E2E_GATEWAY_IMAGE: gatewayImage,
  } = environment;
  if (!binary || !home || !worker || !teammateImage || !gatewayImage)
    return undefined;
  return {
    binary,
    home,
    worker,
    teammateImage,
    gatewayImage,
    path: environment.FLEET_E2E_PATH ?? environment.PATH ?? "/usr/bin:/bin",
    otherClient: environment.FLEET_E2E_OTHER_CLIENT || undefined,
  };
}

/** A free TCP port on the loopback interface. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Run a command, returning its output and exit status instead of throwing on failure. */
export async function command(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(file, [...args], {
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

/** Wait until `predicate` holds, failing after `timeoutMs`. */
export async function eventually(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await sleep(100);
  }
}

/**
 * Bring up the real chain a teammate's `fleet` command takes, with nothing between the processes
 * replaced: the chart's gateway image, run as the chart runs it; fleetd from the pinned binary,
 * configured and supervised by Everything's own Fleet code; Everything's publisher of the client
 * address; and the teammate image, running its workspace API with the read-only Fleet client
 * folder and token file mounted as reconciliation mounts them. All of it is local: containers use
 * the host's network, and nothing is deployed to a cluster.
 */
export async function fleetStack(settings: FleetStackSettings) {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-stack-"));
  const suffix = randomUUID().slice(0, 8);
  const [grpcPort, publicPort, teammatePort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const gatewayUrl = `http://127.0.0.1:${grpcPort}`;
  const token = randomBytes(32).toString("hex");
  const sessionKey = randomBytes(32).toString("hex");
  const key = randomBytes(32).toString("base64");
  const agentId = randomUUID();
  const failures: unknown[] = [];
  const report = (error: unknown) => failures.push(error);

  // ===========================================
  // Gateway: the chart's image and settings, non-root on a read-only root file system
  // ===========================================

  const gatewayName = `fleet-e2e-gateway-${suffix}`;
  const gatewayEnvironment = path.join(directory, "gateway.env");
  await writeFile(
    gatewayEnvironment,
    [
      `FLEET_GATEWAY_GRPC_ADDR=127.0.0.1:${grpcPort}`,
      `FLEET_GATEWAY_PUBLIC_GRPC_URL=${gatewayUrl}`,
      `FLEET_GATEWAY_PUBLIC_ADDR=127.0.0.1:${publicPort}`,
      `FLEET_GATEWAY_PUBLIC_URL=http://127.0.0.1:${publicPort}`,
      `FLEET_GATEWAY_SESSION_KEY=${sessionKey}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  /** Start the gateway container and wait for its gRPC port. */
  async function startGateway(): Promise<void> {
    const started = await command("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      gatewayName,
      "--network",
      "host",
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--env-file",
      gatewayEnvironment,
      settings.gatewayImage,
    ]);
    if (started.code !== 0)
      throw new Error(`The gateway did not start: ${started.output}`);
    await eventually(() => accepts(grpcPort), "the gateway listens");
  }
  /** Remove the gateway container, as a pod replacement would. */
  async function stopGateway(): Promise<void> {
    await command("docker", ["rm", "-f", gatewayName]);
    await eventually(
      async () => !(await accepts(grpcPort)),
      "the gateway stops",
    );
  }

  // ===========================================
  // fleetd: Everything's remote setup and supervisor over the pinned binary
  // ===========================================

  const home = fleetHome(settings.home);
  /** A supervisor of fleetd, as Everything's container creates one each time it starts. */
  const supervisor = () =>
    new FleetDaemon(
      settings.binary,
      fleetEnvironment(home, { PATH: settings.path }),
      home.socket,
      report,
    );
  let daemon = supervisor();
  const folder = path.join(directory, "agents", ".fleet-client");
  const publisher = new FleetClientPublisher(
    home,
    gatewayUrl,
    folder,
    fleetGatewayFileName,
    report,
    { pendingMs: 100, publishedMs: 200 },
  );
  const published = path.join(folder, fleetGatewayFileName);
  /** The address Everything has published for teammates, or empty. */
  const address = async () =>
    (await readFile(published, "utf8").catch(() => "")).trim();

  // ===========================================
  // Teammate: the image's workspace API with reconciliation's mounts
  // ===========================================

  const teammateName = `fleet-e2e-teammate-${suffix}`;
  const workspace = path.join(directory, "agents", agentId);
  const shared = path.join(directory, "agents", "shared");
  const tokenFile = path.join(directory, "token");
  await mkdir(workspace, { recursive: true });
  await mkdir(shared, { recursive: true });
  await writeFile(tokenFile, token);
  await chmod(tokenFile, 0o440);
  /** Start the teammate container and wait for its health endpoint. */
  async function startTeammate(): Promise<void> {
    const started = await command("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      teammateName,
      "--network",
      "host",
      "--user",
      "1000:1000",
      "--read-only",
      "--tmpfs",
      "/tmp:exec,mode=1777",
      "-e",
      `PORT=${teammatePort}`,
      "-e",
      `WORKSPACE_DIRECTORY=${workspacePath(agentId)}`,
      "-e",
      `WORKSPACE_TOKEN=${workspaceToken(key, agentId)}`,
      "-v",
      `${workspace}:${workspacePath(agentId)}`,
      "-v",
      `${shared}:${sharedWorkspacePath}`,
      "-v",
      `${folder}:${fleetClientWorkspaceMount}:ro`,
      "-v",
      `${tokenFile}:${fleetTokenWorkspaceFile}:ro`,
      settings.teammateImage,
    ]);
    if (started.code !== 0)
      throw new Error(`The teammate did not start: ${started.output}`);
    await eventually(
      async () =>
        (
          await fetch(`http://127.0.0.1:${teammatePort}/health`).catch(
            () => undefined,
          )
        )?.ok === true,
      "the teammate's workspace API answers",
    );
  }

  /** Run `fleet` on this machine as a teammate's command would, through the gateway. */
  async function client(
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
    binary = settings.binary,
  ) {
    return command(binary, args, {
      PATH: "/usr/bin:/bin",
      HOME: path.join(directory, "client-home"),
      FLEET_GATEWAY: await address(),
      FLEET_TOKEN: token,
      ...overrides,
    });
  }

  return {
    agentId,
    key,
    token,
    gatewayUrl,
    workspace,
    folder,
    failures,
    address,
    client,
    startGateway,
    stopGateway,
    /** Start the gateway and fleetd as Everything does, and the teammate before any address exists. */
    async start(): Promise<void> {
      await startGateway();
      await new FleetRemoteSetup(home, { gatewayUrl, token }).apply();
      await daemon.start();
      await publisher.prepare();
      await startTeammate();
    },
    /** Stop fleetd and start it again, as replacing Everything's pod does. */
    async restartFleetd(): Promise<void> {
      await daemon.close();
      daemon = supervisor();
      await new FleetRemoteSetup(home, { gatewayUrl, token }).apply();
      await daemon.start();
    },
    /** Begin publishing the client address. */
    publish(): void {
      publisher.start();
    },
    /** Run a command in the teammate container, with its environment rather than a command's. */
    exec(script: string) {
      return command("docker", ["exec", teammateName, "sh", "-c", script]);
    },
    /** Route Everything's requests for this teammate's Service to the container. */
    fetcher: ((url: string | URL | Request, init?: RequestInit) =>
      fetch(
        String(url).replace(
          /^http:\/\/[^/]+/,
          `http://127.0.0.1:${teammatePort}`,
        ),
        init,
      )) as typeof fetch,
    /** Stop every process and container and remove the temporary files. */
    async close(): Promise<void> {
      await publisher.close();
      await command("docker", ["rm", "-f", teammateName]);
      await command("docker", ["rm", "-f", gatewayName]);
      await daemon.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
