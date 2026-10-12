import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  workspaceLimits,
  type FileReadInput,
  type FileReadResult,
  type FileWriteInput,
  type FileWriteResult,
} from "@everything/workspace-contracts";
import { FileAccessError } from "../error/workspace-errors.js";
import type {
  WorkspaceFileAccess,
  WorkspaceDirectories,
} from "../interface/workspace-files.js";

/** Workspace-only file operations; the pod mount is the outer security boundary. */
export class WorkspaceFiles
  implements WorkspaceFileAccess, WorkspaceDirectories
{
  // ===========================================
  // Construction
  // ===========================================

  /** Use only the volume mounted for this teammate. */
  constructor(private readonly root: string) {}

  // ===========================================
  // Files
  // ===========================================

  /** Read a bounded slice without following file links or blocking on special files. */
  async read(input: FileReadInput): Promise<FileReadResult> {
    const location = await this.resolve(input.path);
    const file = await open(
      location,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => {
      throw new FileAccessError();
    });
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new FileAccessError();
      const offset = input.offset ?? 0;
      const buffer = Buffer.alloc(
        Math.min(
          input.limit ?? workspaceLimits.readBytes,
          workspaceLimits.readBytes,
        ),
      );
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      return {
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        bytes: bytesRead,
        nextOffset: offset + bytesRead < info.size ? offset + bytesRead : null,
      };
    } finally {
      await file.close();
    }
  }

  /** Replace files atomically, keeping the previous version if writing fails. */
  async write(input: FileWriteInput): Promise<FileWriteResult> {
    const bytes = Buffer.byteLength(input.content);
    if (bytes > workspaceLimits.writeBytes)
      throw new FileAccessError(
        "The file content exceeds the 1 MiB write limit.",
      );
    const location = await this.resolve(input.path, true);
    const temporary = path.join(
      path.dirname(location),
      `.write-${randomUUID()}`,
    );
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(input.content, "utf8");
      } finally {
        await file.close();
      }
      await rename(temporary, location);
      return { bytes };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Resolve a working directory without entering private runtime state or leaving the volume. */
  async directory(value = "."): Promise<string> {
    return this.resolve(value);
  }

  /** Reject traversal and symlink ancestors; the kernel also confines all paths to this pod's mounts. */
  private async resolve(value: string, createParents = false): Promise<string> {
    const target = path.resolve(this.root, value);
    const relative = path.relative(this.root, target);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep)[0] === ".pi" ||
      value.includes("\0")
    )
      throw new FileAccessError(
        "Use a path inside your workspace. Private conversation files are unavailable.",
      );
    const parent = createParents ? path.dirname(target) : target;
    if (createParents) await mkdir(parent, { recursive: true });
    const resolved = await realpath(parent).catch(() => {
      throw new FileAccessError();
    });
    const fromRoot = path.relative(this.root, resolved);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(fromRoot) ||
      fromRoot.split(path.sep)[0] === ".pi"
    )
      throw new FileAccessError();
    return target;
  }
}
