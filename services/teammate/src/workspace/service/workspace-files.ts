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

/**
 * File operations in the teammate's own workspace and the folder all teammates share; the pod's
 * mounts are the outer security boundary.
 */
export class WorkspaceFiles
  implements WorkspaceFileAccess, WorkspaceDirectories
{
  // ===========================================
  // Construction
  // ===========================================

  /** Use the teammate's workspace, `root`, and the shared folder, `shared`. */
  constructor(
    private readonly root: string,
    private readonly shared: string,
  ) {}

  /** The teammate's own workspace, which is also its home. */
  get home(): string {
    return this.root;
  }

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

  /** Resolve a working directory without entering private runtime state or leaving the mounts. */
  async directory(value = "."): Promise<string> {
    return this.resolve(value);
  }

  /**
   * Resolve a path relative to the workspace, or absolute in it or the shared folder. Reject traversal
   * and symlink ancestors; the kernel also confines all paths to this pod's mounts.
   */
  private async resolve(value: string, createParents = false): Promise<string> {
    const target = path.resolve(this.root, value);
    if (value.includes("\0") || !this.permits(target))
      throw new FileAccessError(
        "Use a path inside your workspace or the shared folder. Private conversation files are unavailable.",
      );
    const parent = createParents ? path.dirname(target) : target;
    if (createParents) await mkdir(parent, { recursive: true });
    const resolved = await realpath(parent).catch(() => {
      throw new FileAccessError();
    });
    if (!this.permits(resolved)) throw new FileAccessError();
    return target;
  }

  /** Whether `location` is in the workspace outside its private runtime state, or in the shared folder. */
  private permits(location: string): boolean {
    return (
      (isInside(this.root, location) &&
        !isInside(path.join(this.root, ".pi"), location)) ||
      isInside(this.shared, location)
    );
  }
}

/** Whether `location` is `directory` or inside it. */
function isInside(directory: string, location: string): boolean {
  const relative = path.relative(directory, location);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
