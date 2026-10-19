import path from "node:path";
import { fleetExecutableName } from "./fleet-release-files.js";

/** Files under Fleet's home directory that Everything writes or fleetd serves. */
export interface FleetHome {
  readonly directory: string;
  /** fleetd's binary directory: its executable, and the pod builds and tmux bundles it stages into pods. */
  readonly binaries: string;
  readonly executable: string;
  /** The socket fleetd listens on and Fleet's clients dial. */
  readonly socket: string;
  /** fleetd's default kubeconfig, which Everything writes for the in-cluster connection. */
  readonly kubeconfig: string;
  /** The Docker CLI's configuration, holding the registry login Fleet builds pull secrets from. */
  readonly dockerConfig: string;
  /** The loopback port of fleetd's MCP server, which fleetd writes when it binds the server. */
  readonly mcpPort: string;
  /**
   * The bearer token fleetd's MCP server requires, readable only by Fleet's account. fleetd reuses
   * it across restarts and requires it of remote clients too.
   */
  readonly mcpToken: string;
  /** fleetd's settings, including how it registers with a gateway for remote control. */
  readonly config: string;
  /** The gateway session fleetd keeps, with the address remote clients dial; it holds secrets too. */
  readonly gatewaySession: string;
  /**
   * fleetd's SSH agent relay, which it points its children's `SSH_AUTH_SOCK` at: the agent of the
   * newest attached Fleet client that has one, otherwise the agent fleetd was started with.
   */
  readonly sshAgentRelay: string;
}

/** Fleet's files under its home directory, where Fleet's own client, `fleet`, finds them too. */
export function fleetHome(directory: string): FleetHome {
  const state = path.join(directory, ".fleet");
  const binaries = path.join(state, "bin");
  return {
    directory,
    binaries,
    executable: path.join(binaries, fleetExecutableName),
    socket: path.join(state, "fleet.sock"),
    kubeconfig: path.join(directory, ".kube", "config"),
    dockerConfig: path.join(directory, ".docker", "config.json"),
    mcpPort: path.join(state, "mcp.port"),
    mcpToken: path.join(state, "mcp.token"),
    config: path.join(state, "config.json"),
    gatewaySession: path.join(state, "gateway_session.json"),
    sshAgentRelay: path.join(state, "ssh-agent", "agent.sock"),
  };
}

/** Variables of Everything's environment that fleetd and the tools it runs need. */
const inheritedVariables = [
  "PATH",
  "LANG",
  "TZ",
  "DOCKER_HOST",
  "SSH_AUTH_SOCK",
] as const;

/**
 * The environment of fleetd and of the Fleet commands Everything runs, with Fleet's home as HOME so
 * Fleet and its tools keep their files on Fleet's volume. Everything's settings and secrets stay out:
 * Fleet resolves `${localEnv:…}` in devcontainer files from fleetd's environment.
 */
export function fleetEnvironment(
  home: FleetHome,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const inherited = inheritedVariables.flatMap((name) =>
    environment[name] === undefined ? [] : [[name, environment[name]]],
  );
  return { ...Object.fromEntries(inherited), HOME: home.directory };
}
