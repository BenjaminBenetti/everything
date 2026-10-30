import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
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
} from "../interface/attachment-files.js";
import type { AttachmentLocation } from "../model/attachment.js";
import {
  attachmentFolder,
  attachmentPath,
  attachmentStagingFolder,
} from "../model/attachment-file.js";

const partialSuffix = ".part";
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const partialPattern =
  /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.part$/;

/** Hard links can't be made on some storage; the file is then copied instead. */
const linkUnsupported = new Set(["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP"]);

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
  }

  /** Partial files untouched since `before`, so one being created right now is never swept. */
  async partials(before: number): Promise<string[]> {
    const entries = await readdir(this.staging).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const stale: string[] = [];
    for (const entry of entries) {
      const id = partialPattern.exec(entry)?.[1];
      if (!id) continue;
      const info = await lstat(path.join(this.staging, entry)).catch(
        () => undefined,
      );
      if (info && info.mtimeMs < before) stale.push(id);
    }
    return stale;
  }

  // ===========================================
  // Files in the teammate's workspace
  // ===========================================

  /**
   * Link the partial file into a folder named for the attachment. Linking never replaces an existing
   * entry, and the folders are reached by descriptor, so the file lands exactly at its path or the
   * upload fails.
   */
  async publish(location: AttachmentLocation): Promise<void> {
    attachmentPath(location);
    const partial = this.partial(location.id);
    try {
      await mkdir(this.workspaces.directory(location.agentId), {
        recursive: true,
      });
      await this.inFolders(location, true, async ({ own }) => {
        const target = path.join(descriptorPath(own), location.fileName);
        await link(partial, target).catch(
          async (error: NodeJS.ErrnoException) => {
            if (!linkUnsupported.has(error.code ?? "")) throw error;
            await copyFile(partial, target, constants.COPYFILE_EXCL);
          },
        );
      });
    } catch {
      throw new AttachmentStorageError();
    }
    await rm(partial, { force: true });
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
