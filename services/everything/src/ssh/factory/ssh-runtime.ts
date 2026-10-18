import type { SecretCipher } from "@everything/security/session-cipher";
import { OpenSshAgent } from "../adapter/open-ssh-agent.js";
import { SshAgentRelay } from "../adapter/ssh-agent-relay.js";
import type {
  SshKeySource,
  SshKeySynchronization,
} from "../interface/ssh-key-source.js";
import { SshKeySynchronizer } from "../service/ssh-key-synchronizer.js";

/** Where the installation's saved keys are held and offered. */
export interface SshSocketPaths {
  /** The private agent holding the keys; consumers never reach it directly. */
  readonly agent: string;
  /** Teammate pods' socket and Fleet's fallback agent: listing and signing only. */
  readonly consumers: string;
  /** Git in Everything's container: saved keys first, then the agents Fleet relays from its clients. */
  readonly fleetGit: string;
  /** Fleet's relay to attached clients' agents, which fleetd's children use as `SSH_AUTH_SOCK`. */
  readonly fleetClients: string;
}

/** The installation's SSH runtime, as Everything's composition root starts, checks, and stops it. */
export interface SshRuntime {
  readonly keys: SshKeySynchronization;
  /** Load the saved keys, then open the consumer sockets. */
  start(): Promise<void>;
  /** Fail while the private agent cannot answer. */
  check(): Promise<void>;
  /** Close the consumer sockets, then stop the agent holding the keys. */
  close(): Promise<void>;
}

/** Assemble the private agent, its synchronization, and the relays consumers use. */
export function createSshRuntime(
  source: SshKeySource,
  cipher: Pick<SecretCipher, "open">,
  sockets: SshSocketPaths,
  reportFailure: () => void,
): SshRuntime {
  const agent = new OpenSshAgent(sockets.agent);
  const keys = new SshKeySynchronizer(source, cipher, agent, reportFailure);
  const relays = [
    new SshAgentRelay(sockets.consumers, [sockets.agent]),
    new SshAgentRelay(sockets.fleetGit, [sockets.agent, sockets.fleetClients]),
  ];
  return {
    keys,
    /** Consumers find the keys already loaded when their sockets appear. */
    async start() {
      await keys.start();
      for (const relay of relays) await relay.start();
    },
    /** Readiness asks the agent itself, not a relay that would answer while it is down. */
    async check() {
      await agent.identities();
    },
    /** No consumer can reach the agent while it stops. */
    async close() {
      for (const relay of relays) await relay.close();
      await keys.close();
    },
  };
}
