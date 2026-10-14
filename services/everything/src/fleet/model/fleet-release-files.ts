/** A CPU architecture as Fleet's release file names spell it. */
export type FleetArchitecture = "amd64" | "arm64";

/** Node architectures Fleet instances may run on; each needs its own pod build and tmux bundle. */
export const nodeArchitectures: readonly FleetArchitecture[] = [
  "amd64",
  "arm64",
];

/** A release file and the name Everything installs it under in Fleet's binary directory. */
export interface FleetReleaseFile {
  readonly asset: string;
  readonly installName: string;
}

/** Name of fleetd's executable in Fleet's binary directory. */
export const fleetExecutableName = "fleet";

/** Fleet's spelling of a Node.js `process.arch`. */
export function fleetArchitecture(arch: string): FleetArchitecture {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`Fleet publishes no build for the ${arch} architecture.`);
}

/**
 * The files Everything installs: fleetd for this container's architecture, and the pod build and
 * tmux bundle for every node architecture, under the names fleetd looks for them in its binary
 * directory before it would download them itself.
 */
export function fleetReleaseFiles(
  daemon: FleetArchitecture,
): readonly FleetReleaseFile[] {
  return [
    { asset: `fleet-linux-${daemon}`, installName: fleetExecutableName },
    ...nodeArchitectures.flatMap((arch) =>
      [`fleet-pod-linux-${arch}`, `fleet-tmux-linux-${arch}.tar.gz`].map(
        (asset) => ({ asset, installName: asset }),
      ),
    ),
  ];
}
