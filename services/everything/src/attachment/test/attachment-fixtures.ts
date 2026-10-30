import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentCatalog } from "../../agent/interface/agent-catalog.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { WorkspaceAttachmentFiles } from "../adapter/workspace-attachment-files.js";
import { AttachmentInUseError } from "../error/attachment-errors.js";
import type {
  AttachmentExpiry,
  AttachmentExpiryStore,
  AttachmentStore,
  LocatedAttachment,
  NewAttachment,
} from "../interface/attachment-repository.js";
import type {
  Attachment,
  AttachmentKind,
  AttachmentOwnerScope,
  AttachmentScope,
} from "../model/attachment.js";
import { AttachmentNotFoundError } from "../error/attachment-errors.js";

export const ownerId = "owner";
export const agentId = "11111111-1111-4111-8111-111111111111";
export const otherAgentId = "22222222-2222-4222-8222-222222222222";
export const strangerAgentId = "33333333-3333-4333-8333-333333333333";

/** Teammates and their owners: one owner with two teammates, and a stranger's teammate. */
const teammates: Record<string, string> = {
  [agentId]: ownerId,
  [otherAgentId]: ownerId,
  [strangerAgentId]: "stranger",
};

/** Ownership checks as the agent catalog performs them: other owners' teammates look missing. */
export const agents: Pick<AgentCatalog, "get"> = {
  async get(owner, id) {
    if (teammates[id] !== owner) throw new AgentNotFoundError();
    return {
      id,
      ownerId: owner,
      name: "Avery",
      systemPrompt: "Help with files.",
      avatarId: "avatar-01",
      inference: null,
      createdAt: "2026-10-30T00:00:00.000Z",
    };
  },
};

type Row = Attachment & { readonly agentId: string };

/** Attachment records in memory, applying the same scope rules as the PostgreSQL repository. */
export class MemoryAttachments
  implements AttachmentStore, AttachmentExpiryStore
{
  // ===========================================
  // State
  // ===========================================

  readonly rows = new Map<string, Row>();
  private clock = Date.parse("2026-10-30T00:00:00.000Z");

  /** Use the given teammates and their owners; the fixture teammates by default. */
  constructor(private readonly owners: Record<string, string> = teammates) {}

  // ===========================================
  // Repository
  // ===========================================

  /** Find a record within scope; other owners' and other teammates' records are missing. */
  async getById(scope: AttachmentScope, id: string) {
    const row = this.visible(scope, id);
    return row && this.entity(row);
  }

  /** Insert only for the teammate's owner. */
  async create(scope: AttachmentOwnerScope, attachment: NewAttachment) {
    if (this.owners[scope.agentId] !== scope.ownerId)
      throw new AgentNotFoundError();
    const now = this.tick();
    const row: Row = {
      ...attachment,
      agentId: scope.agentId,
      createdAt: now,
      updatedAt: now,
      received: 0,
      status: "uploading",
      kind: null,
      mediaType: null,
      messageId: null,
    };
    this.rows.set(row.id, row);
    return this.entity(row);
  }

  /** Advance an upload in progress. */
  async progress(scope: AttachmentOwnerScope, id: string, received: number) {
    return this.update(scope, id, { received });
  }

  /** Complete an upload in progress. */
  async complete(
    scope: AttachmentOwnerScope,
    id: string,
    facts: { kind: AttachmentKind; mediaType: string },
  ) {
    const row = this.visible(scope, id);
    if (!row) throw new AttachmentNotFoundError();
    return this.update(scope, id, {
      ...facts,
      status: "ready",
      received: row.size,
    });
  }

  /** Unsent records of the teammate, oldest first. */
  async unsent(scope: AttachmentOwnerScope) {
    return [...this.rows.values()]
      .filter((row) => this.visible(scope, row.id) && !row.messageId)
      .map((row) => this.entity(row));
  }

  /** Remove unsent records; sent ones are refused. */
  async removeUnsent(scope: AttachmentOwnerScope, id: string) {
    const row = this.visible(scope, id);
    if (!row) return undefined;
    if (row.messageId) throw new AttachmentInUseError();
    this.rows.delete(id);
    return this.entity(row);
  }

  /** Unsent records past either cutoff. */
  async expired(scope: AttachmentScope, expiry: AttachmentExpiry) {
    return [...this.rows.values()]
      .filter((row) => this.visible(scope, row.id) && isExpired(row, expiry))
      .map((row): LocatedAttachment => ({
        ...this.entity(row),
        agentId: row.agentId,
      }));
  }

  /** Remove a record only if it is still expired. */
  async removeExpired(
    scope: AttachmentScope,
    id: string,
    expiry: AttachmentExpiry,
  ) {
    const row = this.visible(scope, id);
    if (!row || !isExpired(row, expiry)) return undefined;
    this.rows.delete(id);
    return { ...this.entity(row), agentId: row.agentId };
  }

  // ===========================================
  // Test controls
  // ===========================================

  /** Attach records to a message, as saving a message does. */
  claim(ids: readonly string[], messageId: string): void {
    for (const id of ids)
      this.rows.set(id, { ...this.rows.get(id)!, messageId });
  }

  /** Move a record's last activity into the past. */
  age(id: string, updatedAt: string): void {
    this.rows.set(id, { ...this.rows.get(id)!, updatedAt });
  }

  // ===========================================
  // Helpers
  // ===========================================

  /** Apply scope the way `scopeWhere` does. */
  private visible(scope: AttachmentScope, id: string): Row | undefined {
    const row = this.rows.get(id);
    if (!row) return undefined;
    if ("ownership" in scope) return row;
    return row.agentId === scope.agentId &&
      this.owners[row.agentId] === scope.ownerId
      ? row
      : undefined;
  }

  /** Update a visible upload in progress. */
  private update(
    scope: AttachmentOwnerScope,
    id: string,
    changes: Partial<Row>,
  ) {
    const row = this.visible(scope, id);
    if (!row || row.status !== "uploading") throw new AttachmentNotFoundError();
    const updated = { ...row, ...changes, updatedAt: this.tick() };
    this.rows.set(id, updated);
    return this.entity(updated);
  }

  /** Strip the teammate identity, as `toEntity` does. */
  private entity({ agentId: _agentId, ...attachment }: Row): Attachment {
    return attachment;
  }

  /** A strictly increasing timestamp. */
  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
}

/** Whether an unsent record is past its cutoff. */
function isExpired(
  row: Row,
  { uploadingBefore, readyBefore }: AttachmentExpiry,
) {
  if (row.messageId) return false;
  return row.status === "uploading"
    ? row.updatedAt < uploadingBefore
    : row.updatedAt < readyBefore;
}

/** A temporary workspace volume with the teammates' folders, removed after the test. */
export async function workspaceVolume(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "everything-attachments-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = new FileSystemWorkspaces(root);
  await workspaces.createShared();
  return {
    root,
    workspaces,
    files: new WorkspaceAttachmentFiles(root, workspaces),
    /** The local folder that holds a teammate's workspace. */
    workspace: (id: string) => workspaces.directory(id),
    /** Map a teammate's runtime path to this volume. */
    local: (runtimePath: string) =>
      path.join(root, path.posix.relative("/workspace", runtimePath)),
  };
}

/** Chunks for a streamed body. */
export async function* chunks(
  ...parts: Uint8Array[]
): AsyncIterable<Uint8Array> {
  for (const part of parts) yield part;
}

/** A valid RGBA PNG of the given size, filled with one color. */
export function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 4, Buffer.from([0x33, 0x66, 0x99, 0xff])),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A small, valid 2×1 PNG image. */
export const pngBytes = png(2, 1);

/** Bytes that are neither text nor an image, including NUL and invalid UTF-8. */
export const binaryBytes = Buffer.from([
  0x00, 0xff, 0xfe, 0x01, 0x80, 0x7f, 0x00, 0xc3, 0x28, 0xa0, 0xa1, 0x00,
]);
