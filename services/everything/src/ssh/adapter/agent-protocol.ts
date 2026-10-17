import { createConnection, type Socket } from "node:net";

/** SSH agent protocol message numbers used here (draft-miller-ssh-agent). */
export const agentMessage = {
  failure: 5,
  success: 6,
  requestIdentities: 11,
  identitiesAnswer: 12,
  signRequest: 13,
  removeIdentity: 18,
  extension: 27,
} as const;

/** OpenSSH's AGENT_MAX_LEN: no legitimate message is larger. */
const maxMessageBytes = 256 * 1024;

/** A complete SSH_AGENT_FAILURE message. */
export const failureReply = frame(agentMessage.failure);

/** A complete SSH_AGENT_SUCCESS message. */
export const successReply = frame(agentMessage.success);

/** One public identity an agent offers, as its wire-format blob and comment. */
export interface AgentIdentity {
  readonly blob: Buffer;
  readonly comment: Buffer;
}

/** Build a length-prefixed message of `type` whose body is `fields`, already encoded. */
export function frame(type: number, ...fields: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.of(type), ...fields]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

/** Encode an SSH `string`: a 32-bit length followed by the bytes. */
export function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** Encode a 32-bit unsigned integer. */
export function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

/** Read the SSH `string` at `offset`, returning it and the offset after it; malformed input throws. */
export function readString(buffer: Buffer, offset: number): [Buffer, number] {
  if (offset + 4 > buffer.length) throw new Error("Truncated agent message");
  const end = offset + 4 + buffer.readUInt32BE(offset);
  if (end > buffer.length) throw new Error("Truncated agent message");
  return [buffer.subarray(offset + 4, end), end];
}

/** The message number of a complete message. */
export function messageType(message: Buffer): number {
  return message[4] ?? -1;
}

/** The name of a complete SSH_AGENTC_EXTENSION message, or undefined when it is malformed. */
export function extensionName(message: Buffer): string | undefined {
  try {
    return readString(message, 5)[0].toString("latin1");
  } catch {
    return undefined;
  }
}

/** The identities in a complete SSH_AGENT_IDENTITIES_ANSWER message; malformed input throws. */
export function parseIdentities(message: Buffer): AgentIdentity[] {
  if (messageType(message) !== agentMessage.identitiesAnswer)
    throw new Error("Unexpected agent reply");
  if (message.length < 9) throw new Error("Truncated agent message");
  const count = message.readUInt32BE(5);
  const identities: AgentIdentity[] = [];
  let offset = 9;
  for (let index = 0; index < count; index++) {
    const [blob, afterBlob] = readString(message, offset);
    const [comment, afterComment] = readString(message, afterBlob);
    identities.push({ blob, comment });
    offset = afterComment;
  }
  return identities;
}

/** An SSH_AGENT_IDENTITIES_ANSWER message listing `identities`. */
export function identitiesReply(identities: readonly AgentIdentity[]): Buffer {
  return frame(
    agentMessage.identitiesAnswer,
    uint32(identities.length),
    ...identities.flatMap(({ blob, comment }) => [
      sshString(blob),
      sshString(comment),
    ]),
  );
}

/** Reassemble complete, bounded messages from a byte stream that arrives in arbitrary chunks. */
export class AgentMessageReader {
  private buffered = Buffer.alloc(0);

  /** Add `chunk` and return every message it completes; an oversized or empty message throws. */
  push(chunk: Buffer): Buffer[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: Buffer[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length < 1 || length > maxMessageBytes)
        throw new Error("Agent message exceeds the protocol limit");
      if (this.buffered.length < 4 + length) break;
      messages.push(this.buffered.subarray(0, 4 + length));
      this.buffered = this.buffered.subarray(4 + length);
    }
    return messages;
  }
}

/**
 * One client connection to an agent socket that sends a request and waits for its reply, one at a
 * time. A timeout or broken connection destroys it, so a late reply can never answer a later request.
 */
export class AgentConnection {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly reader = new AgentMessageReader();
  private readonly replies: Buffer[] = [];
  private waiting: ((reply: Buffer | undefined) => void) | undefined;
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      try {
        this.replies.push(...this.reader.push(chunk));
      } catch {
        this.close();
        return;
      }
      this.deliver();
    });
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }

  /** Connect to the agent at `socketPath`, failing after `timeoutMs`. */
  static open(socketPath: string, timeoutMs: number): Promise<AgentConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("SSH agent did not accept the connection"));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new AgentConnection(socket));
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("SSH agent is unavailable"));
      });
    });
  }

  // ===========================================
  // Requests
  // ===========================================

  /** Send one complete message and return the agent's complete reply. */
  request(message: Buffer, timeoutMs: number): Promise<Buffer> {
    if (this.closed || this.waiting)
      return Promise.reject(new Error("SSH agent connection is not ready"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), timeoutMs);
      this.waiting = (reply) => {
        clearTimeout(timer);
        if (reply) resolve(reply);
        else reject(new Error("SSH agent did not answer"));
      };
      this.socket.write(message);
      this.deliver();
    });
  }

  /** End the connection and fail any request still waiting. */
  close(): void {
    this.closed = true;
    this.socket.destroy();
    this.deliver();
  }

  /** Hand the next reply, or the connection's end, to the waiting request. */
  private deliver(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    const reply = this.replies.shift();
    if (!reply && !this.closed) return;
    this.waiting = undefined;
    waiting(reply);
  }
}

/** Send one request on a fresh connection to `socketPath` and return the reply. */
export async function agentRequest(
  socketPath: string,
  message: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  const connection = await AgentConnection.open(socketPath, timeoutMs);
  try {
    return await connection.request(message, timeoutMs);
  } finally {
    connection.close();
  }
}
