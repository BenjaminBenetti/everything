import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import type { AgentWorkspaces } from "../../workspace/interface/agent-workspaces.js";
import {
  AttachmentNotFoundError,
  AttachmentOffsetError,
  AttachmentStorageError,
  AttachmentTooLargeError,
} from "../error/attachment-errors.js";
import type {
  AttachmentContent,
  AttachmentFiles,
  PreparedAttachmentFile,
} from "../interface/attachment-files.js";
import {
  attachmentLimits,
  type AttachmentLocation,
} from "../model/attachment.js";
import type { AttachmentImageEncoder } from "../interface/attachment-image-encoder.js";
import { PngWebpEncoder } from "./png-webp-encoder.js";
import {
  attachmentFolder,
  attachmentPath,
  attachmentStagingFolder,
  attachmentSniffBytes,
  storedFileName,
  storedFileNamePattern,
  webpName,
} from "../model/attachment-file.js";

const partialSuffix = ".part";
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const partialPattern =
  /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(part|webp|publish)$/;

/**
 * Attachment files on the workspace volume that Everything's container shares with teammate pods.
 * Partial uploads stay in a controller-owned folder at the volume's root, which no teammate pod
 * mounts. A complete file moves into `<workspace>/attachments/<id>/<name>`, reached one directory at
 * a time through open descriptors that refuse symbolic links, so a link a teammate places in its own
 * workspace can never redirect a write, read, or removal to another teammate's files or to
 * Everything's own state.
 */
export class WorkspaceAttachmentFiles implements AttachmentFiles {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly staging: string;

  /** Use the workspace volume's root and the teammates' workspace directories inside it. */
  constructor(
    root: string,
    private readonly workspaces: Pick<AgentWorkspaces, "directory">,
    private readonly encoder: AttachmentImageEncoder = new PngWebpEncoder(),
  ) {
    this.staging = path.join(path.resolve(root), attachmentStagingFolder);
  }

  // ===========================================
  // Partial uploads
  // ===========================================

  /** Create the partial file exclusively, so an upload never reuses another's bytes. */
  async begin(id: string): Promise<void> {
    await mkdir(this.staging, { recursive: true, mode: 0o700 });
    const file = await open(
      this.partial(id),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
    await file.close();
  }

  /** Write as bytes arrive, so memory stays bounded by the stream's chunks whatever the part's size. */
  async append(
    id: string,
    offset: number,
    body: AsyncIterable<Uint8Array>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const file = await open(
      this.partial(id),
      constants.O_WRONLY | constants.O_NOFOLLOW,
    ).catch(() => {
      throw new AttachmentNotFoundError();
    });
    let written = 0;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new AttachmentNotFoundError();
      if (info.size !== offset) throw new AttachmentOffsetError();
      for await (const chunk of body) {
        signal?.throwIfAborted();
        if (written + chunk.byteLength > limit)
          throw new AttachmentTooLargeError();
        await writeAll(file, chunk, offset + written);
        written += chunk.byteLength;
      }
      signal?.throwIfAborted();
      return written;
    } catch (error) {
      // Keep only the bytes saved before this part, so the part can be sent again.
      await file.truncate(offset).catch(() => undefined);
      throw error;
    } finally {
      await file.close();
    }
  }

  /** Read the start of the partial file to tell what it is. */
  async head(id: string, bytes: number): Promise<Uint8Array> {
    const file = await open(
      this.partial(id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await file.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  /** Remove a partial file, ignoring one that's already gone. */
  async discard(id: string): Promise<void> {
    await rm(this.partial(id), { force: true });
    await rm(this.encoded(id), { force: true });
    await this.discardPublication(id);
  }

  /** Only complete bounded regular files enter the codec; every temporary byte stays controller-private. */
  async prepare(
    location: AttachmentLocation,
    inputSize: number,
    signal?: AbortSignal,
    encodePng = true,
  ): Promise<PreparedAttachmentFile> {
    attachmentPath(location);
    const file = await open(
      this.partial(location.id),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size !== inputSize ||
        info.size > attachmentLimits.maxFileBytes
      )
        throw new AttachmentStorageError();
      signal?.throwIfAborted();
      const head = Buffer.alloc(Math.min(attachmentSniffBytes, info.size));
      await readAll(file, head);
      const original = { location, size: info.size, head, encoded: false };
      if (!encodePng) return original;
      if (
        head.length < 8 ||
        !head
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        return original;
      const bytes = Buffer.alloc(info.size);
      await readAll(file, bytes);
      const webp = await this.encoder.webp(bytes, signal);
      signal?.throwIfAborted();
      if (!webp || webp.byteLength >= bytes.length) return original;
      await rm(this.encoded(location.id), { force: true });
      const encoded = await open(
        this.encoded(location.id),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o644,
      );
      try {
        await writeAll(encoded, webp, 0);
        await encoded.sync();
      } finally {
        await encoded.close();
      }
      signal?.throwIfAborted();
      return {
        location: {
          ...location,
          fileName: storedFileName(webpName(location.fileName)),
        },
        size: webp.byteLength,
        head: webp.subarray(0, attachmentSniffBytes),
        encoded: true,
      };
    } finally {
      await file.close();
    }
  }

  /** An abort before metadata preparation restores the exact original input offset for retry. */
  async rewind(id: string, offset: number): Promise<void> {
    await rm(this.encoded(id), { force: true });
    const file = await open(
      this.partial(id),
      constants.O_WRONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < offset)
        throw new AttachmentOffsetError();
      await file.truncate(offset);
    } finally {
      await file.close();
    }
  }

  /** Partial files untouched since `before`, so one being created right now is never swept. */
  async partials(before: number): Promise<string[]> {
    const entries = await readdir(this.staging).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const stale = new Set<string>();
    for (const entry of entries) {
      const id = partialPattern.exec(entry)?.[1];
      if (!id) continue;
      const info = await lstat(path.join(this.staging, entry)).catch(
        () => undefined,
      );
      if (info && info.mtimeMs < before) stale.add(id);
    }
    return [...stale];
  }

  // ===========================================
  // Files in the teammate's workspace
  // ===========================================

  /**
   * Copy from an opened no-follow source descriptor into a controller-private directory, then rename
   * that directory atomically through a no-follow workspace parent. Teammates never see a partially
   * copied file; existing nonempty folders, files and links are never replaced.
   */
  async publish(location: AttachmentLocation, encoded = false): Promise<void> {
    attachmentPath(location);
    const file = await open(
      encoded ? this.encoded(location.id) : this.partial(location.id),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => {
      throw new AttachmentStorageError();
    });
    let published = false;
    const opened: FileHandle[] = [];
    try {
      if (!(await file.stat()).isFile()) throw new AttachmentStorageError();
      await this.discardPublication(location.id);
      const prepared = this.publication(location.id);
      await mkdir(prepared, { mode: 0o700 });
      const privateFolder = await openDirectory(prepared);
      opened.push(privateFolder);
      // Read only from the opened source FD. Copy remains invisible to every teammate.
      const candidate = path.join(
        descriptorPath(privateFolder),
        location.fileName,
      );
      await copyFile(
        "/proc/self/fd/" + file.fd,
        candidate,
        constants.COPYFILE_EXCL,
      );
      const complete = await open(
        candidate,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await complete.sync();
      } finally {
        await complete.close();
      }
      // The controller-private parent still hides this directory; preserve published workspace permissions.
      await privateFolder.chmod(0o755);
      await mkdir(this.workspaces.directory(location.agentId), {
        recursive: true,
      });
      const workspace = await openDirectory(
        this.workspaces.directory(location.agentId),
      );
      opened.push(workspace);
      const container = await openChild(workspace, attachmentFolder, true);
      opened.push(container);
      // Same-PVC directory rename reveals one complete file atomically, refuses symlinks/nonempty targets.
      await rename(prepared, path.join(descriptorPath(container), location.id));
      published = true;
      await this.discard(location.id);
    } catch {
      if (published) await this.remove(location).catch(() => undefined);
      throw new AttachmentStorageError();
    } finally {
      await file.close();
      for (const handle of opened.reverse()) await handle.close();
      await this.discardPublication(location.id);
    }
  }

  /** Remove the file and its folder; anything missing or replaced by a link is left alone. */
  async remove(location: AttachmentLocation): Promise<void> {
    await this.inFolders(location, false, async ({ container, own }) => {
      await unlink(path.join(descriptorPath(own), location.fileName)).catch(
        ignoreMissing,
      );
      await rmdir(path.join(descriptorPath(container), location.id)).catch(
        ignoreMissing,
      );
    }).catch(ignoreMissing);
  }

  /** Open the file without following a link at any step, or report it gone. */
  async open(
    location: AttachmentLocation,
  ): Promise<AttachmentContent | undefined> {
    try {
      return await this.inFolders(location, false, async ({ own }) => {
        const file = await open(
          path.join(descriptorPath(own), location.fileName),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const info = await file.stat();
        if (!info.isFile()) {
          await file.close();
          return undefined;
        }
        return { size: info.size, stream: file.createReadStream() };
      });
    } catch {
      return undefined;
    }
  }

  // ===========================================
  // Paths
  // ===========================================

  /** The partial file of an upload, named only by its server-generated ID. */
  private partial(id: string): string {
    if (!uuidPattern.test(id)) throw new Error("Invalid attachment identifier");
    return path.join(this.staging, `${id}${partialSuffix}`);
  }

  /** Server-owned candidate paths are derived only from the already validated upload UUID. */
  private encoded(id: string): string {
    return this.partial(id).slice(0, -partialSuffix.length) + ".webp";
  }
  private publication(id: string): string {
    return this.partial(id).slice(0, -partialSuffix.length) + ".publish";
  }

  /** A publication folder contains at most one safe filename; never recurse or follow a directory link. */
  private async discardPublication(id: string): Promise<void> {
    const directory = await openDirectory(this.publication(id)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!directory) return;
    try {
      const entries = await readdir(descriptorPath(directory));
      if (
        entries.length > 1 ||
        entries.some((name) => !storedFileNamePattern.test(name))
      )
        throw new AttachmentStorageError();
      for (const name of entries)
        await unlink(path.join(descriptorPath(directory), name)).catch(
          ignoreMissing,
        );
      await rmdir(this.publication(id)).catch(ignoreMissing);
    } finally {
      await directory.close();
    }
  }

  /**
   * Run `work` with the workspace's attachments folder and the attachment's own folder open. Each is
   * opened inside the one before by descriptor and refused if it is a link or not a directory.
   */
  private async inFolders<T>(
    location: AttachmentLocation,
    create: boolean,
    work: (folders: { container: FileHandle; own: FileHandle }) => Promise<T>,
  ): Promise<T> {
    const opened: FileHandle[] = [];
    try {
      const workspace = await openDirectory(
        this.workspaces.directory(location.agentId),
      );
      opened.push(workspace);
      const container = await openChild(workspace, attachmentFolder, create);
      opened.push(container);
      const own = await openChild(container, location.id, create);
      opened.push(own);
      return await work({ container, own });
    } finally {
      for (const handle of opened.reverse()) await handle.close();
    }
  }
}

/** Fill a bounded buffer from position zero without changing the source descriptor's identity. */
async function readAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!result.bytesRead) throw new AttachmentStorageError();
    offset += result.bytesRead;
  }
}

/** A path that names an open directory itself, whatever later happens to the names that led to it. */
function descriptorPath(directory: FileHandle): string {
  return `/proc/self/fd/${directory.fd}`;
}

/** Open a directory, refusing a link in its final component. */
function openDirectory(location: string): Promise<FileHandle> {
  return open(
    location,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}

/** Open, and optionally first create, the directory `name` inside an open directory. */
async function openChild(
  parent: FileHandle,
  name: string,
  create: boolean,
): Promise<FileHandle> {
  const location = path.join(descriptorPath(parent), name);
  if (create)
    await mkdir(location, { mode: 0o755 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  return openDirectory(location);
}

/** Write a whole chunk at `position`, continuing after short writes. */
async function writeAll(
  file: FileHandle,
  chunk: Uint8Array,
  position: number,
): Promise<void> {
  let done = 0;
  while (done < chunk.byteLength) {
    const { bytesWritten } = await file.write(
      chunk,
      done,
      chunk.byteLength - done,
      position + done,
    );
    done += bytesWritten;
  }
}

/** Treat an entry that is gone, replaced by a link, or not a directory as already removed. */
function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (!["ENOENT", "ELOOP", "ENOTDIR", "ENOTEMPTY"].includes(error.code ?? ""))
    throw error;
}
