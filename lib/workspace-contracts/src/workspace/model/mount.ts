/**
 * Where teammates' workspaces live. Each teammate's pod and Everything's container mount them at the
 * same paths, so a path names the same files wherever a teammate, Everything, or Fleet uses it.
 */
export const workspaceRoot = "/workspace";

/** The workspace volume's folder that every teammate can read and write, beside their own. */
export const sharedWorkspaceFolder = "shared";

/** Where the shared folder is mounted, for handing files from one teammate to another. */
export const sharedWorkspacePath = `${workspaceRoot}/${sharedWorkspaceFolder}`;

/** Controller-owned socket directory; teammate pods receive only a read-only subpath mount. */
export const sshAgentFolder = ".ssh-agent";
export const sshAgentHostSocket = `${workspaceRoot}/${sshAgentFolder}/agent.sock`;
export const sshAgentWorkspaceMount = "/run/ssh-agent";
export const sshAgentWorkspaceSocket = `${sshAgentWorkspaceMount}/agent.sock`;

/**
 * Controller-owned folder where Everything publishes the address of its Fleet gateway session, which
 * the `fleet` command in teammate pods dials; pods receive only a read-only subpath mount.
 */
export const fleetClientFolder = ".fleet-client";
export const fleetClientWorkspaceMount = "/run/fleet-client";
/** The published `FLEET_GATEWAY` value, one line, in the Fleet client folder. */
export const fleetGatewayFileName = "gateway-url";
/** The Fleet client token, mounted from the chart's Secret into teammate pods. */
export const fleetTokenWorkspaceFile = "/run/secrets/fleet/token";

/** A teammate's own workspace, which is also its home: `/workspace/<agent id>`. */
export function workspacePath(agentId: string): string {
  return `${workspaceRoot}/${agentId}`;
}
