import { chmod } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  AgentConnection,
  AgentMessageReader,
  agentMessage,
  extensionName,
  failureReply,
  frame,
  identitiesReply,
  messageType,
  parseIdentities,
  readString,
  successReply,
  type AgentIdentity,
} from "./agent-protocol.js";
import { preparePrivateSocket, removeSocket } from "./private-socket.js";

/** Time an upstream gets to accept a connection; dialing a local socket is immediate. */
const connectTimeoutMs = 3000;
/** Time an upstream gets to answer; above Fleet's own wait for a client's remote agent. */
const replyTimeoutMs = 15_000;

/**
 * Serve an SSH agent socket that lets consumers list identities and sign with them, and nothing
 * else: adding, removing, locking, and provider loading are refused before any upstream sees them.
 * Identities from several upstream agents are offered in upstream order without duplicates, and
 * each signature request goes to the upstream that offered its key.
 */
export class SshAgentRelay {
  // ===========================================
  // State and construction
  // ===========================================

  private server: Server | undefined;
  private readonly clients = new Set<Socket>();

  /** Listen at `socketPath` for the agents at `upstreams`, the first preferred. */
  constructor(
    readonly socketPath: string,
    private readonly upstreams: readonly string[],
  ) {}

  // ===========================================
  // Lifecycle
  // ===========================================

  /** Bind the socket in a private directory, readable and writable only by this account. */
  async start(): Promise<void> {
    if (this.server) return;
    await preparePrivateSocket(this.socketPath);
    const server = createServer((client) => void this.serve(client));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    await chmod(this.socketPath, 0o600);
  }

  /** Stop listening, end every consumer's connection, and remove the socket. */
  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    for (const client of this.clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeSocket(this.socketPath);
  }

  // ===========================================
  // Connections
  // ===========================================

  /** Answer one consumer's requests in order; a malformed or oversized message ends its connection. */
  private async serve(client: Socket): Promise<void> {
    this.clients.add(client);
    client.on("error", () => undefined);
    const session = new RelaySession(this.upstreams);
    const reader = new AgentMessageReader();
    try {
      for await (const chunk of client)
        for (const message of reader.push(chunk as Buffer))
          client.write(await session.answer(message));
    } catch {
      // The consumer sent something no agent would accept, or its connection broke.
    } finally {
      session.close();
      client.destroy();
      this.clients.delete(client);
    }
  }
}

/** One consumer connection's upstream connections and the upstream that offered each key. */
class RelaySession {
  private readonly connections: (AgentConnection | null | undefined)[];
  private readonly owners = new Map<string, number>();

  /** Open upstream connections lazily, keeping each for the consumer connection's lifetime. */
  constructor(private readonly upstreams: readonly string[]) {
    this.connections = upstreams.map(() => undefined);
  }

  /** Answer one complete request message. */
  async answer(message: Buffer): Promise<Buffer> {
    switch (messageType(message)) {
      case agentMessage.requestIdentities:
        return this.identities();
      case agentMessage.signRequest:
        return this.sign(message);
      case agentMessage.extension:
        return extensionName(message) === "session-bind@openssh.com"
          ? this.bind(message)
          : failureReply;
      default:
        return failureReply;
    }
  }

  /** End every upstream connection. */
  close(): void {
    for (const connection of this.connections) connection?.close();
  }

  /** Offer every reachable upstream's identities, first upstream first, each key once. */
  private async identities(): Promise<Buffer> {
    this.owners.clear();
    const offered: AgentIdentity[] = [];
    for (let index = 0; index < this.upstreams.length; index++) {
      const reply = await this.request(
        index,
        frame(agentMessage.requestIdentities),
      );
      let identities: AgentIdentity[];
      try {
        identities = reply ? parseIdentities(reply) : [];
      } catch {
        continue;
      }
      for (const identity of identities) {
        const key = identity.blob.toString("base64");
        if (this.owners.has(key)) continue;
        this.owners.set(key, index);
        offered.push(identity);
      }
    }
    return identitiesReply(offered);
  }

  /** Forward a signature request unchanged to the upstream that offered its key. */
  private async sign(message: Buffer): Promise<Buffer> {
    let key: string;
    try {
      key = readString(message, 5)[0].toString("base64");
    } catch {
      return failureReply;
    }
    if (!this.owners.has(key)) await this.identities();
    const index = this.owners.get(key);
    if (index === undefined) return failureReply;
    return (await this.request(index, message)) ?? failureReply;
  }

  /** Bind every upstream to the consumer's SSH session, so destination constraints still apply. */
  private async bind(message: Buffer): Promise<Buffer> {
    let bound = false;
    for (let index = 0; index < this.upstreams.length; index++) {
      const reply = await this.request(index, message);
      if (reply && messageType(reply) === agentMessage.success) bound = true;
    }
    return bound ? successReply : failureReply;
  }

  /** Send a request to one upstream; an unreachable or silent upstream is skipped for this session. */
  private async request(
    index: number,
    message: Buffer,
  ): Promise<Buffer | undefined> {
    let connection = this.connections[index];
    if (connection === null) return undefined;
    try {
      connection ??= await AgentConnection.open(
        this.upstreams[index]!,
        connectTimeoutMs,
      );
      this.connections[index] = connection;
      return await connection.request(message, replyTimeoutMs);
    } catch {
      connection?.close();
      this.connections[index] = null;
      return undefined;
    }
  }
}
