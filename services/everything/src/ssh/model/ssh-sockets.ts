/** Everything's private SSH directory, on its own `/tmp` volume, which no other pod mounts. */
export const privateSshDirectory = "/tmp/everything-ssh";

/** The OpenSSH agent holding the installation's saved keys; only Everything and its relays use it. */
export const sshAgentSocket = `${privateSshDirectory}/agent.sock`;

/**
 * The relay Git commands in Everything's container use, through the `IdentityAgent` setting that
 * `container/Dockerfile` adds to the image's SSH client configuration: saved keys first, then the
 * keys of a Fleet client attached to provide its agent.
 */
export const fleetGitAgentSocket = `${privateSshDirectory}/fleet-git.sock`;
